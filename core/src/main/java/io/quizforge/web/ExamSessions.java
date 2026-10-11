package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.BooleanSupplier;

/** Host-owned exam attempts. A durable lock precedes grading, including timeout grading. */
final class ExamSessions implements AutoCloseable {
    private static final java.util.Set<String> PRIVATE_RECORD_FIELDS = java.util.Set.of("packages", "questions", "features", "requestId", "description", "pageSession");
    private final Path directory;
    private final Library library;
    private final StateStore states;
    private final AiGradingService ai;
    private final CollectionRoutes routes;
    private final CollectionRoutes.Writes writes;
    private final BooleanSupplier automaticAi;
    private final Clock clock;
    private final Map<String, ObjectNode> records = new java.util.concurrent.ConcurrentHashMap<>();
    private final Map<String, Library.Collection> collections = new LinkedHashMap<>(8, .75f, true);
    private final TemporaryExamSessions temporary;
    private java.util.function.Function<ResourceStore, AiGateway> resourceGateway;
    void resourceGateway(java.util.function.Function<ResourceStore, AiGateway> factory) { resourceGateway = factory; }

    ExamSessions(Path root, Library library, StateStore states, AiGradingService ai,
                 CollectionRoutes routes, CollectionRoutes.Writes writes, BooleanSupplier automaticAi) throws IOException {
        this(root, library, states, ai, routes, writes, automaticAi, Clock.systemUTC());
    }
    ExamSessions(Path root, Library library, StateStore states, AiGradingService ai,
                 CollectionRoutes routes, CollectionRoutes.Writes writes, BooleanSupplier automaticAi, Clock clock) throws IOException {
        this.directory = root.resolve(".state/exams"); this.library = library; this.states = states;
        this.ai = ai; this.routes = routes; this.writes = writes; this.automaticAi = automaticAi; this.clock = clock;
        temporary = new TemporaryExamSessions(clock);
        if (Files.isSymbolicLink(directory)) throw new IOException("Unsafe exam directory");
        Files.createDirectories(directory);
        try (var files = Files.list(directory)) {
            for (Path path : files.filter(p -> p.getFileName().toString().matches("[a-f0-9-]{36}")).toList()) {
                if (Files.isSymbolicLink(path)) throw new IOException("Unsafe exam snapshot");
                Path record = path.resolve("exam.json");
                if (Files.isRegularFile(record, LinkOption.NOFOLLOW_LINKS)) {
                    try {
                        ObjectNode value = (ObjectNode) Json.read(record, 32 * 1024 * 1024);
                        if (!value.path("id").asText().equals(path.getFileName().toString())) throw new IOException("Invalid exam identity");
                        if (value.path("status").asText().equals("deleted")) { records.put(value.path("id").asText(), value); continue; }
                        Path snapshot = path.resolve("snapshot.json");
                        ObjectNode source = Files.exists(snapshot, LinkOption.NOFOLLOW_LINKS) ? (ObjectNode) Json.read(snapshot, 32 * 1024 * 1024) : value;
                        restore(source); value.put("questionCount", source.path("questions").size()); records.put(value.path("id").asText(), value);
                        if (Files.exists(snapshot, LinkOption.NOFOLLOW_LINKS)) value.remove(List.of("packages", "questions", "description"));
                    } catch (IOException | RuntimeException error) { System.err.println("An unreadable exam snapshot was preserved: " + path.getFileName()); }
                }
            }
        }
        library.examCollections(this::collection);
    }
    Library.Collection collection(String id) {
        synchronized (collections) {
            require(id);
            Library.Collection value = collections.get(id); if (value != null) return value;
            ObjectNode record = records.get(id); if (record == null) throw new ApiException(404, "COLLECTION_NOT_FOUND", "考试记录不存在。");
            try {
                Path file = directory.resolve(id).resolve("snapshot.json");
                value = restore(record.has("packages") ? record : (ObjectNode) Json.read(file, 32 * 1024 * 1024)); cache(value); return value;
            } catch (IOException error) { throw new ApiException(503, "EXAM_SNAPSHOT_UNAVAILABLE", "考试快照暂不可读取，已保存的数据仍保留。"); }
        }
    }
    private void cache(Library.Collection collection) {
        synchronized (collections) {
            collections.put(collection.id(), collection);
            while (collections.size() > 8) { String oldest = collections.keySet().stream().filter(id -> !temporary.contains(id)).findFirst().orElse(null); if (oldest == null) break; collections.remove(oldest); }
        }
    }
    synchronized ObjectNode list(String kind, String bankId) { return list(kind, bankId, null); }
    synchronized ObjectNode list(String kind, String bankId, String pageSession) {
        tick(); temporary.touchPage(pageSession, false); ObjectNode result = Json.object(); var rows = result.putArray("records");
        records.values().stream().filter(r -> !r.path("status").asText().equals("deleted") && r.path("bankKind").asText().equals(kind) && r.path("bankId").asText().equals(bankId) && (r.at("/features/history").asBoolean(true) || java.util.Objects.equals(r.path("pageSession").asText(null), pageSession)))
                .sorted(java.util.Comparator.comparing((ObjectNode r) -> r.path("startedAt").asText()).reversed()).forEach(r -> rows.add(publicRecord(r)));
        return result;
    }
    synchronized ObjectNode submit(String id) { ObjectNode record = require(id); advance(record); handIn(record, "manual"); return publicRecord(record); }
    synchronized ObjectNode delete(String id, String pageSession) {
        expireTemporary();
        ObjectNode record = records.get(id);
        if (record == null || !record.at("/features/history").asBoolean(true) && !java.util.Objects.equals(record.path("pageSession").asText(null), pageSession))
            throw new ApiException(404, "COLLECTION_NOT_FOUND", "考试记录不存在。");
        if (!record.at("/features/history").asBoolean(true)) TemporaryExamSessions.requireOwner(pageSession);
        if (record.path("status").asText().equals("completed")) throw new ApiException(409, "EXAM_COMPLETED", "考试已完成，请在历史记录中查看或删除。");
        if (!record.path("status").asText().equals("deleted")) {
            ObjectNode deleted = record.deepCopy().put("status", "deleted").put("deletedAt", clock.instant().toString());
            deleted.remove(List.of("packages", "questions", "description", "summary", "gradingErrors", "aiErrors"));
            // Persist cancellation before hiding the attempt: a restart must not resume its deadline or grading.
            persist(deleted); records.put(id, deleted);
            synchronized (collections) { collections.remove(id); }
            temporary.deleted(id, encodedBytes(deleted), this::invalidateTemporary);
        }
        if (!record.at("/features/history").asBoolean(true)) cleanupTemporarySnapshot(id);
        return Json.object().put("deleted", id);
    }
    static boolean isHistoryId(String id) { return id.matches("exam-[a-f0-9-]{36}"); }
    // Keep exam storage independent, but expose completed attempts through the source bank's history.
    synchronized ObjectNode appendHistory(String kind, String bankId, ObjectNode history) {
        tick(); var rows = new ArrayList<JsonNode>(); history.path("records").forEach(rows::add);
        for (ObjectNode record : records.values()) {
            if (!belongsToHistory(record, kind, bankId)) continue;
            String historyId = record.at("/summary/historyId").asText();
            for (JsonNode row : states.history("exam", record.path("id").asText(), null).path("records"))
                if (row.path("id").asText().equals(historyId)) rows.add(historyRecord(record, (ObjectNode) row));
        }
        rows.sort(java.util.Comparator.comparing((JsonNode row) -> Instant.parse(row.path("updatedAt").asText())).reversed());
        var result = history.deepCopy(); var combined = result.putArray("records"); rows.forEach(combined::add); return result;
    }
    synchronized ObjectNode history(String kind, String bankId, String id, boolean delete) {
        ObjectNode record = records.get(id.substring("exam-".length()));
        if (record == null || !belongsToHistory(record, kind, bankId)) throw new ApiException(404, "HISTORY_NOT_FOUND", "考试历史记录不存在。");
        String nativeId = record.at("/summary/historyId").asText(), examId = record.path("id").asText();
        if (delete) { states.deleteHistory("exam", examId, nativeId); return Json.object().put("deleted", id); }
        return historyRecord(record, states.history("exam", examId, nativeId));
    }
    private static boolean belongsToHistory(ObjectNode record, String kind, String bankId) {
        return record.path("bankKind").asText().equals(kind) && record.path("bankId").asText().equals(bankId)
                && record.path("status").asText().equals("completed") && record.at("/features/history").asBoolean(true)
                && record.at("/summary/historyId").isTextual();
    }
    private static ObjectNode historyRecord(ObjectNode exam, ObjectNode entry) {
        var value = entry.deepCopy(); String id = exam.path("id").asText();
        value.put("id", "exam-" + id).put("mode", "exam").put("examId", id);
        value.set("createdAt", exam.path("startedAt")); value.set("updatedAt", exam.path("finishedAt")); return value;
    }
    synchronized ObjectNode start(Library.Collection source, JsonNode request) { return start(source, request, null); }
    synchronized ObjectNode start(Library.Collection source, JsonNode request, String pageSession) {
        if (!List.of("bank", "development-bank").contains(source.kind()) || !source.features().exam())
            throw new ApiException(403, "EXAM_DISABLED", "题库未开启考试模式。");
        String requestId = Json.id(request, "requestId"); if (requestId.length() < 8) throw ApiException.bad("Invalid requestId");
        JsonNode duration = request.get("durationMinutes");
        if (duration == null || !(duration.isNull() || duration.isIntegralNumber() && duration.canConvertToInt() && duration.asInt() >= 1 && duration.asInt() <= 1440)) throw ApiException.bad("考试时长须为 1–1440 分钟或 null（不限时）。");
        expireTemporary();
        if (!source.features().history()) { TemporaryExamSessions.requireOwner(pageSession); temporary.touchPage(pageSession, false); }
        for (ObjectNode record : records.values()) if (record.path("requestId").asText().equals(requestId)) {
            if (!record.path("bankKind").asText().equals(source.kind()) || !record.path("bankId").asText().equals(source.id()) || !record.path("durationMinutes").equals(duration) || !record.at("/features/history").asBoolean(true) && !java.util.Objects.equals(record.path("pageSession").asText(null), pageSession)) throw new ApiException(409, "REQUEST_ID_REUSED", "考试请求编号已使用。");
            if (record.path("status").asText().equals("deleted")) throw new ApiException(409, "EXAM_DELETED", "这次考试已删除，请重新开始考试。");
            return publicRecord(record);
        }
        if (!source.features().history()) temporary.checkAdmission(0);
        String id = UUID.randomUUID().toString(); Instant now = clock.instant();
        ObjectNode record = Json.object().put("id", id).put("bankKind", source.kind()).put("bankId", source.id()).put("title", source.title())
                .put("description", source.description()).put("requestId", requestId).put("startedAt", now.toString()).put("status", "in-progress");
        record.set("durationMinutes", duration.deepCopy()); record.set("features", source.features().json());
        if (!source.features().history()) record.put("pageSession", pageSession);
        if (duration.isNull()) record.putNull("deadline"); else record.put("deadline", now.plusSeconds(duration.asLong() * 60).toString());
        var packages = record.putArray("packages"); var questions = record.putArray("questions");
        try {
            for (Library.Extension extension : source.extensions()) {
                ObjectNode pkg = describe(extension); String folder = "packages/" + extension.fingerprint() + "/" + extension.directory().getFileName(); pkg.put("folder", folder);
                copyPackage(extension.directory(), directory.resolve(id).resolve(folder)); packages.add(pkg);
            }
            for (Library.Question question : source.questions()) {
                if (source.kind().startsWith("development")) copyImages(question.data());
                ObjectNode row = Json.object().put("id", question.id()).put("title", question.title()).put("fingerprint", question.fingerprint()).put("package", source.extensionFor(question).fingerprint());
                row.set("data", question.data().deepCopy());
                if (question.outline() != null) {
                    var outline = row.putObject("outline").put("level", question.outline().level()).put("label", question.outline().label());
                    var items = outline.putArray("items"); for (Library.OutlineItem item : question.outline().items()) items.add(Json.object().put("id", item.id()).put("label", item.label()));
                }
                var items = row.putArray("outlineItems"); for (Library.OutlineItem item : question.outlineItems()) items.add(Json.object().put("id", item.id()).put("label", item.label()));
                questions.add(row);
            }
            Library.Collection frozen = restore(record);
            if (!source.features().history()) {
                Path root = directory.getParent().getParent(); StateStore memory = states.temporary(root); ResourceStore images = ResourceStore.memory(root, new ResourceStore(root));
                AiGradingService grading = resourceGateway == null ? ai.temporary(root, memory) : ai.temporary(root, memory, resourceGateway.apply(images));
                var runtime = new TemporaryExamSessions.Runtime(memory, grading, new CollectionRoutes(library, memory, grading, writes, automaticAi), images);
                try { temporary.add(id, pageSession, runtime, 2 * encodedBytes(record)); }
                catch (RuntimeException error) { runtime.close(); throw error; }
            }
            record.put("questionCount", questions.size()); store(record).overview(frozen); persist(record);
            records.put(id, record); cache(frozen); return publicRecord(record);
        } catch (IOException error) { temporary.discard(id); if (!source.features().history()) cleanupTemporarySnapshot(id); throw new ApiException(500, "EXAM_START_FAILED", "无法保存考试快照，原练习进度未改变。"); }
        catch (RuntimeException error) { temporary.discard(id); if (!source.features().history()) cleanupTemporarySnapshot(id); throw error; }
    }
    synchronized JsonNode route(HttpExchange exchange, String method, String[] parts) throws IOException {
        expireTemporary();
        String id = Json.id(Json.object().put("id", parts[3]), "id");
        if (parts.length == 5 && parts[4].equals("exam") && method.equals("DELETE")) {
            writes.validateOrigin(exchange); return delete(id, exchange.getRequestHeaders().getFirst("X-QuizForge-Practice-Session"));
        }
        ObjectNode record = require(id);
        if (!record.at("/features/history").asBoolean(true)) temporary.access(id, exchange.getRequestHeaders().getFirst("X-QuizForge-Practice-Session"), !method.equals("GET"));
        advance(record);
        Library.Collection collection = collection(id); boolean active = record.path("status").asText().equals("in-progress");
        if (parts.length >= 5 && parts[4].equals("resources")) {
            TemporaryExamSessions.Runtime runtime = temporary.runtime(id); ResourceStore images = runtime == null ? new ResourceStore(directory.getParent().getParent()) : runtime.resources();
            if (parts.length == 5 && method.equals("POST")) { JsonNode input = writes.read(exchange); if (!active) throw new ApiException(403, "EXAM_ACTION_DISABLED", "交卷后不能上传作答图片。"); return images.upload(input); }
            if (parts.length == 6 && method.equals("GET")) { var image = images.read(parts[5]); return Json.object().put("id", image.id()).put("mime", image.mime()).put("size", image.bytes().length).put("data", java.util.Base64.getEncoder().encodeToString(image.bytes())); }
        }
        if (parts.length == 5 && parts[4].equals("exam")) {
            if (method.equals("GET")) return publicRecord(record);
            if (method.equals("POST")) { writes.read(exchange); return submit(id); }
        }
        if (parts.length == 7 && parts[4].equals("questions") && parts[6].equals("page") && method.equals("GET")) {
            Library.Extension extension = collection.extensionFor(collection.question(parts[5])); ObjectNode page = Library.snapshotPage(extension);
            // Exact built-in identities have known legacy button IDs. Do not guess other types' DOM.
            if (extension.id().equals("quizforge.single-choice") && extension.version().equals("1.0.0") || extension.id().equals("quizforge.short-answer") && extension.version().equals("1.3.0")) page.putArray("examActionSelectors").add("#submit-button").add("#retry-button");
            return page;
        }
        if (!method.equals("GET")) {
            if (parts.length == 7 && parts[6].equals("actions")) {
                JsonNode action = writes.read(exchange); String operation = action.path("action").asText();
                boolean review = operation.equals("review") && record.path("status").asText().equals("grading") && record.path("gradingErrors").size() == 0;
                if (!review && (!active || !List.of("draft", "whiteboard").contains(operation))) throw new ApiException(403, "EXAM_ACTION_DISABLED", "考试只允许保存答案和草稿，请使用宿主的交卷按钮。");
                ObjectNode response = store(record).act(collection, collection.question(parts[5]), action); response.set("exam", publicRecord(record)); return response;
            }
            if (parts.length >= 8 && parts[6].equals("ai") && !active && !record.path("status").asText().equals("completed")) return dispatch(record).route(exchange, method, parts);
            throw new ApiException(403, "EXAM_ACTION_DISABLED", "考试期间不能编辑、重做或单题提交。");
        }
        if (parts.length >= 7 && List.of("editor", "edit").contains(parts[6]) || parts.length >= 5 && parts[4].equals("summary") && active)
            throw new ApiException(403, "EXAM_ACTION_DISABLED", "交卷后才能查看答案和分值。");
        JsonNode response = dispatch(record).route(exchange, method, parts);
        if (response instanceof ObjectNode object) object.set("exam", publicRecord(record));
        // Partial grading is private until every saved answer has been submitted successfully.
        if (record.path("gradingErrors").size() > 0 && parts.length == 6 && parts[4].equals("questions")) throw new ApiException(409, "EXAM_GRADING_FAILED", "交卷已锁定，请重试评分；答案仍保留。");
        return response;
    }
    synchronized void tick() {
        expireTemporary();
        for (ObjectNode record : records.values()) try { advance(record); }
        catch (RuntimeException error) { System.err.println("Exam processing failed: " + (error instanceof ApiException api ? api.code : "EXAM_PROCESSING_FAILED")); }
    }
    private void advance(ObjectNode record) {
        if (record.path("status").asText().equals("in-progress") && record.path("deadline").isTextual() && !clock.instant().isBefore(Instant.parse(record.path("deadline").asText()))) handIn(record, "timeout");
        else if (record.path("status").asText().equals("grading") && record.path("gradingErrors").size() == 0) {
            if (!record.path("submissionComplete").asBoolean()) handIn(record, record.path("submissionReason").asText("manual")); else complete(record);
        }
    }
    private void handIn(ObjectNode record, String reason) {
        if (record.path("status").asText().equals("completed")) return;
        if (record.path("status").asText().equals("in-progress")) {
            record.put("status", "grading").put("submittedAt", clock.instant().toString()).put("submissionReason", reason).put("submissionComplete", false);
        }
        persist(record); // Also restores the lock before resuming a crash-interrupted submission.
        Library.Collection collection = collection(record.path("id").asText()); var errors = record.putArray("gradingErrors");
        StateStore states = store(record); AiGradingService ai = grading(record);
        for (Library.Question question : collection.questions()) {
            try {
                ObjectNode payload = states.question(collection, question);
                if (!payload.at("/state/status").asText().equals("submitted") && !payload.at("/state/answer").isNull()) {
                    ObjectNode action = Json.object().put("requestId", "exam-submit-" + Json.fingerprint(Json.object().put("id", question.id()), collection.id())).put("revision", payload.at("/state/revision").asLong()).put("action", "submit");
                    action.putObject("data").set("answer", payload.at("/state/answer").deepCopy()); payload = states.act(collection, question, action);
                }
                if (automaticAi.getAsBoolean() && payload.at("/capabilities/canAiGrade").asBoolean()) {
                    var taskIds = states.currentAiTaskIds(collection, question);
                    if (taskIds.isEmpty() && !payload.at("/state/result/gradingSource").asText().equals("manual")) ai.startAutomatic(collection, question, Json.object().put("requestId", "exam-auto-" + Json.fingerprint(Json.object().put("id", question.id()).put("contentVersion", payload.at("/stamp/contentVersion").asText()), collection.id())).put("contentVersion", payload.at("/stamp/contentVersion").asText()));
                    else for (String taskId : taskIds) if (ai.get(collection, question, taskId).path("status").asText().equals("failed")) ai.retry(collection, question, taskId, Json.object().put("requestId", "exam-retry-" + UUID.randomUUID()));
                }
            } catch (RuntimeException error) {
                errors.add(Json.object().put("questionId", question.id()).put("code", error instanceof ApiException api ? api.code : "GRADING_FAILED").put("message", "该题评分未完成，已保存的答案仍保留。"));
            }
        }
        record.put("submissionComplete", errors.isEmpty()); persist(record); if (errors.isEmpty()) complete(record);
    }
    private void complete(ObjectNode record) {
        Library.Collection collection = collection(record.path("id").asText());
        StateStore states = store(record); AiGradingService ai = grading(record);
        JsonNode previousErrors = record.path("aiErrors").deepCopy(); var failures = record.putArray("aiErrors"); boolean pending = false;
        for (Library.Question question : collection.questions()) for (String taskId : states.currentAiTaskIds(collection, question)) {
            String status = ai.get(collection, question, taskId).path("status").asText();
            if (List.of("queued", "running", "succeeded").contains(status)) pending = true;
            if (status.equals("failed")) failures.add(Json.object().put("questionId", question.id()).put("taskId", taskId).put("message", "AI 评分失败，请重试或人工评分。"));
        }
        if (!previousErrors.equals(failures)) persist(record);
        if (pending || !failures.isEmpty()) return;
        ObjectNode summary = states.summary(collection);
        if (summary.path("pendingCount").asInt() > 0) return;
        ObjectNode command = Json.object().put("requestId", "exam-finish-" + collection.id()).put("summaryVersion", summary.path("summaryVersion").asText()); command.set("roundId", summary.path("roundId"));
        ObjectNode completed;
        if (summary.path("finished").asBoolean()) { completed = summary.deepCopy(); if (collection.features().history()) completed.set("historyId", summary.path("roundId")); else completed.putNull("historyId"); }
        else completed = states.finish(collection, command);
        record.set("summary", completed);
        record.put("status", "completed").put("finishedAt", clock.instant().toString()); persist(record);
    }
    private ObjectNode require(String id) { ObjectNode record = records.get(id); if (record == null || record.path("status").asText().equals("deleted")) throw new ApiException(404, "COLLECTION_NOT_FOUND", "考试记录不存在。"); return record; }
    private ObjectNode publicRecord(ObjectNode record) {
        ObjectNode result = Json.object();
        record.fields().forEachRemaining(entry -> { if (!PRIVATE_RECORD_FIELDS.contains(entry.getKey())) result.set(entry.getKey(), entry.getValue().deepCopy()); });
        result.put("serverTime", clock.instant().toString()); return result;
    }
    private void persist(ObjectNode record) {
        if (!record.at("/features/history").asBoolean(true)) return;
        Path folder = directory.resolve(record.path("id").asText()), target = folder.resolve("exam.json"), temporary = folder.resolve("exam.pending");
        try {
            Files.createDirectories(folder);
            if (record.has("packages")) {
                Path snapshot = folder.resolve("snapshot.json"); if (Files.isSymbolicLink(snapshot)) throw new IOException("Unsafe exam snapshot");
                if (!Files.exists(snapshot, LinkOption.NOFOLLOW_LINKS)) {
                    try (var channel = java.nio.channels.FileChannel.open(snapshot, java.nio.file.StandardOpenOption.CREATE_NEW, java.nio.file.StandardOpenOption.WRITE)) {
                        var buffer = java.nio.ByteBuffer.wrap(Json.MAPPER.writeValueAsBytes(record)); while (buffer.hasRemaining()) channel.write(buffer); channel.force(true);
                    }
                }
            }
            ObjectNode metadata = record.deepCopy(); metadata.remove(List.of("packages", "questions", "description")); byte[] bytes = Json.MAPPER.writeValueAsBytes(metadata);
            if (Files.isSymbolicLink(folder) || Files.isSymbolicLink(target) || Files.isSymbolicLink(temporary)) throw new IOException("Unsafe exam file");
            try (var channel = java.nio.channels.FileChannel.open(temporary, java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.TRUNCATE_EXISTING, java.nio.file.StandardOpenOption.WRITE)) {
                var buffer = java.nio.ByteBuffer.wrap(bytes); while (buffer.hasRemaining()) channel.write(buffer); channel.force(true);
            }
            Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            record.remove(List.of("packages", "questions", "description"));
        } catch (IOException error) { throw new ApiException(500, "EXAM_SAVE_FAILED", "考试记录保存失败，已保存的答案仍保留。"); }
    }
    private Library.Collection restore(ObjectNode record) throws IOException {
        Map<String, Library.Extension> extensions = new LinkedHashMap<>();
        for (JsonNode pkg : record.path("packages")) {
            Path folder = directory.resolve(record.path("id").asText()).resolve(pkg.path("folder").asText()).normalize();
            if (!folder.startsWith(directory) || Files.isSymbolicLink(folder)) throw new IOException("Unsafe exam package");
            List<Library.Dependency> dependencies = new ArrayList<>(); for (JsonNode dependency : pkg.path("dependencies")) dependencies.add(new Library.Dependency(dependency.path("id").asText(), dependency.path("version").asText()));
            extensions.put(pkg.path("fingerprint").asText(), new Library.Extension(pkg.path("id").asText(), pkg.path("version").asText(), pkg.path("name").asText(), pkg.path("description").asText(), folder,
                    file(folder, pkg, "entry"), file(folder, pkg, "script"), file(folder, pkg, "style"), file(folder, pkg, "rules"), file(folder, pkg, "questionSchema"), file(folder, pkg, "answerSchema"), null,
                    pkg.path("fingerprint").asText(), dependencies, pkg.path("contentApi").isObject() ? (ObjectNode) pkg.path("contentApi") : null, pkg.path("providerRevision").asText(), pkg.path("outlineItemsDeclared").asBoolean()));
        }
        List<Library.Question> questions = new ArrayList<>();
        for (JsonNode row : record.path("questions")) {
            Library.Outline outline = row.has("outline") ? new Library.Outline(row.at("/outline/level").asText(), row.at("/outline/label").asText(), items(row.at("/outline/items"))) : null;
            Library.Extension extension = extensions.get(row.path("package").asText()); if (extension == null) throw new IOException("Missing exam extension");
            questions.add(new Library.Question(row.path("id").asText(), row.path("title").asText(), row.path("data").deepCopy(), row.path("fingerprint").asText(), extension, items(row.path("outlineItems")), outline));
        }
        return new Library.Collection(record.path("id").asText(), record.path("title").asText(), record.path("description").asText(), "exam", null, questions,
                new BankFeatures(false, record.at("/features/whiteboard").asBoolean(true), record.at("/features/history").asBoolean(true), false));
    }
    private static List<Library.OutlineItem> items(JsonNode rows) { List<Library.OutlineItem> result = new ArrayList<>(); for (JsonNode item : rows) result.add(new Library.OutlineItem(item.path("id").asText(), item.path("label").asText())); return result; }
    private static Path file(Path folder, JsonNode pkg, String key) throws IOException { return pkg.path(key).isTextual() ? Json.safeFile(folder, pkg.path(key).asText()) : null; }
    private static ObjectNode describe(Library.Extension extension) {
        ObjectNode result = Json.object().put("id", extension.id()).put("version", extension.version()).put("name", extension.name()).put("description", extension.description()).put("fingerprint", extension.fingerprint()).put("providerRevision", extension.providerRevision()).put("outlineItemsDeclared", extension.outlineItemsDeclared());
        Map<String, Path> files = new LinkedHashMap<>(); files.put("entry", extension.entry()); files.put("script", extension.script()); files.put("style", extension.style()); files.put("rules", extension.rules()); files.put("questionSchema", extension.questionSchema()); files.put("answerSchema", extension.answerSchema());
        files.forEach((name, file) -> { if (file != null) result.put(name, extension.directory().relativize(file).toString().replace('\\', '/')); });
        if (extension.contentApi() != null) result.set("contentApi", extension.contentApi().deepCopy());
        var dependencies = result.putArray("dependencies"); for (Library.Dependency dependency : extension.dependencies()) dependencies.add(Json.object().put("id", dependency.id()).put("version", dependency.version())); return result;
    }
    private static void copyPackage(Path source, Path target) throws IOException {
        long bytes = 0; int count = 0;
        try (var paths = Files.walk(source)) {
            for (Path path : paths.toList()) {
                if (Files.isSymbolicLink(path)) throw new IOException("Exam packages cannot contain symlinks");
                Path destination = target.resolve(source.relativize(path));
                if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) Files.createDirectories(destination);
                else if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                    bytes += Files.size(path); if (++count > 4096 || bytes > 128L * 1024 * 1024) throw new IOException("Exam package snapshot is too large");
                    Files.copy(path, destination);
                } else throw new IOException("Invalid exam package file");
            }
        }
    }
    private StateStore store(ObjectNode record) { TemporaryExamSessions.Runtime runtime = temporary.runtime(record.path("id").asText()); return runtime == null ? states : runtime.states(); }
    private AiGradingService grading(ObjectNode record) { TemporaryExamSessions.Runtime runtime = temporary.runtime(record.path("id").asText()); return runtime == null ? ai : runtime.ai(); }
    private CollectionRoutes dispatch(ObjectNode record) { TemporaryExamSessions.Runtime runtime = temporary.runtime(record.path("id").asText()); return runtime == null ? routes : runtime.routes(); }
    private static long encodedBytes(JsonNode value) { try { return Json.MAPPER.writeValueAsBytes(value).length; } catch (IOException error) { throw new IllegalStateException(error); } }
    private void expireTemporary() { temporary.expire(this::invalidateTemporary); }
    private void invalidateTemporary(String id) { records.remove(id); synchronized (collections) { collections.remove(id); } cleanupTemporarySnapshot(id); }
    private void cleanupTemporarySnapshot(String id) {
        try {
            if (!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")) throw new IOException("Invalid temporary exam identity");
            Path base = directory.toAbsolutePath().normalize(), folder = base.resolve(id).normalize();
            if (!folder.getParent().equals(base) || Files.isSymbolicLink(base) || Files.isSymbolicLink(base.getParent()) || Files.isSymbolicLink(folder)) throw new IOException("Unsafe temporary exam directory");
            if (!Files.exists(folder, LinkOption.NOFOLLOW_LINKS)) return;
            Path realBase = base.toRealPath(), realFolder = folder.toRealPath();
            if (!realFolder.getParent().equals(realBase)) throw new IOException("Temporary exam directory escapes its storage root");
            try (var children = Files.list(folder)) {
                if (children.anyMatch(path -> !path.getFileName().toString().equals("packages"))) throw new IOException("Preserve unrelated or durable exam files");
            }
            // Validate the whole generated tree before removing any files; a changed path is preserved.
            var validator = new java.nio.file.SimpleFileVisitor<Path>() {
                void verify(Path path, java.nio.file.attribute.BasicFileAttributes attributes) throws IOException {
                    if (!path.toAbsolutePath().normalize().startsWith(folder) || Files.isSymbolicLink(path) || attributes.isSymbolicLink()
                            || !(attributes.isDirectory() || attributes.isRegularFile()) || !path.toRealPath().startsWith(realFolder)) throw new IOException("Unsafe temporary exam snapshot path");
                    if (path.getParent().equals(folder) && !path.getFileName().toString().equals("packages")) throw new IOException("Preserve unrelated or durable exam files");
                }
                @Override public java.nio.file.FileVisitResult preVisitDirectory(Path path, java.nio.file.attribute.BasicFileAttributes attributes) throws IOException { verify(path, attributes); return java.nio.file.FileVisitResult.CONTINUE; }
                @Override public java.nio.file.FileVisitResult visitFile(Path path, java.nio.file.attribute.BasicFileAttributes attributes) throws IOException { verify(path, attributes); return java.nio.file.FileVisitResult.CONTINUE; }
            };
            Files.walkFileTree(folder, validator);
            Files.walkFileTree(folder, new java.nio.file.SimpleFileVisitor<Path>() {
                @Override public java.nio.file.FileVisitResult visitFile(Path path, java.nio.file.attribute.BasicFileAttributes attributes) throws IOException { validator.verify(path, attributes); Files.delete(path); return java.nio.file.FileVisitResult.CONTINUE; }
                @Override public java.nio.file.FileVisitResult postVisitDirectory(Path path, IOException error) throws IOException { if (error != null) throw error; validator.verify(path, Files.readAttributes(path, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS)); Files.delete(path); return java.nio.file.FileVisitResult.CONTINUE; }
            });
        } catch (IOException error) { System.err.println("An unsafe or changed temporary exam snapshot was preserved: " + id); }
    }
    private void copyImages(JsonNode node) throws IOException {
        if (node.isContainerNode()) { for (JsonNode value : node) copyImages(value); }
        else if (node.isTextual() && node.asText().matches("[a-f0-9]{64}")) {
            Path root = directory.getParent().getParent(); ResourceStore source = new ResourceStore(root.resolve(".development")), target = new ResourceStore(root);
            try { var image = source.read(node.asText()); target.upload(Json.object().put("mime", image.mime()).put("data", java.util.Base64.getEncoder().encodeToString(image.bytes()))); }
            catch (ApiException error) { if (!error.code.equals("RESOURCE_NOT_FOUND")) throw error; }
        }
    }
    @Override public synchronized void close() { temporary.close(); for (ObjectNode record : List.copyOf(records.values())) if (!record.at("/features/history").asBoolean(true)) invalidateTemporary(record.path("id").asText()); }
}

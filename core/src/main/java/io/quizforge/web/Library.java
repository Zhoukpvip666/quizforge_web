package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class Library {
    record Dependency(String id, String version) { }
    record Extension(String id, String version, String name, String description, Path directory,
                     Path entry, Path script, Path style, Path rules, Path questionSchema, Path answerSchema, Path examples, String fingerprint, List<Dependency> dependencies, ObjectNode contentApi, String providerRevision, boolean outlineItemsDeclared) {
        Extension(String id, String version, String name, String description, Path directory, Path entry, Path script, Path style, Path rules, Path questionSchema, Path answerSchema, Path examples, String fingerprint) {
            this(id, version, name, description, directory, entry, script, style, rules, questionSchema, answerSchema, examples, fingerprint, List.of());
        }
        Extension(String id, String version, String name, String description, Path directory, Path entry, Path script, Path style, Path rules, Path questionSchema, Path answerSchema, Path examples, String fingerprint, List<Dependency> dependencies) {
            this(id, version, name, description, directory, entry, script, style, rules, questionSchema, answerSchema, examples, fingerprint, dependencies, null, "", false);
        }
    }
    record OutlineItem(String id, String label) { }
    record Outline(String level, String label, List<OutlineItem> items) {
        Outline { items = List.copyOf(items); }
    }
    record Question(String id, String title, JsonNode data, String fingerprint, Extension extension, List<OutlineItem> outlineItems, Outline outline) {
        Question { outlineItems = List.copyOf(outlineItems); }
        Question(String id, String title, JsonNode data, String fingerprint) { this(id, title, data, fingerprint, null); }
        Question(String id, String title, JsonNode data, String fingerprint, Extension extension) { this(id, title, data, fingerprint, extension, List.of()); }
        Question(String id, String title, JsonNode data, String fingerprint, Extension extension, List<OutlineItem> outlineItems) { this(id, title, data, fingerprint, extension, outlineItems, null); }
    }
    record EditPlan(Path path, byte[] before, byte[] after, Collection collection, Question question) { }
    record Collection(String id, String title, String description, String kind, Extension extension, List<Question> questions,
                      List<Extension> extensions, String extensionFingerprint, BankFeatures features) {
        private record Bindings(List<Question> questions, List<Extension> extensions, String fingerprint) { }
        Collection(String id, String title, String description, String kind, Extension extension, List<Question> questions) {
            this(id, title, description, kind, extension, bindings(extension, questions), BankFeatures.DEFAULT);
        }
        Collection(String id, String title, String description, String kind, Extension extension, List<Question> questions, BankFeatures features) {
            this(id, title, description, kind, extension, bindings(extension, questions), features);
        }
        private Collection(String id, String title, String description, String kind, Extension extension, Bindings bindings, BankFeatures features) {
            this(id, title, description, kind, extension, bindings.questions(), bindings.extensions(), bindings.fingerprint(), features);
        }
        Collection {
            questions = List.copyOf(questions); extensions = List.copyOf(extensions);
        }
        String stateKey() { return kind + ":" + id + ":" + (extension == null ? "mixed" : extension.id() + ":" + extension.version()); }
        Question question(String id) { return questions.stream().filter(q -> q.id().equals(id)).findFirst().orElseThrow(() -> new ApiException(404, "QUESTION_NOT_FOUND", "Question does not exist")); }
        Extension extensionFor(Question question) {
            Extension value = question.extension() == null ? extension : question.extension();
            if (value == null) throw ApiException.bad("Question extension is missing");
            return value;
        }
        private static Bindings bindings(Extension extension, List<Question> questions) {
            List<Question> resolved = questions.stream().map(q -> q.extension() == null && extension != null ? new Question(q.id(), q.title(), q.data(), q.fingerprint(), extension, q.outlineItems(), q.outline()) : q).toList();
            var values = new LinkedHashMap<String, Extension>();
            for (Question question : resolved) {
                Extension value = question.extension(); if (value == null) throw ApiException.bad("Question extension is missing");
                values.putIfAbsent(value.id() + "@" + value.version() + ":" + value.fingerprint(), value);
            }
            List<Extension> used = List.copyOf(values.values());
            if (extension != null) return new Bindings(resolved, used, extension.fingerprint());
            ArrayNode identities = Json.MAPPER.createArrayNode();
            used.stream().sorted(Comparator.comparing(e -> e.id() + "@" + e.version())).forEach(e -> identities.add(Json.object().put("id", e.id()).put("version", e.version()).put("fingerprint", e.fingerprint())));
            return new Bindings(resolved, used, Json.fingerprint(identities, "quizforge-mixed-extensions-v1"));
        }
    }
    private final Path root;
    private final Path codeRoot;
    private final RuleEngine engine;
    private final ResourceStore resources;
    private final RichTextService richText;
    private final DevelopmentSettings developmentSettings;
    private final ResourceStore developmentResources;
    private Map<String, Extension> extensions = Map.of();
    private Map<String, Collection> banks = Map.of(), previews = Map.of();
    private Map<String, DevelopmentExtensions.Package> developmentPackages = Map.of();
    private Map<String, Extension> developmentExtensions = Map.of(), developmentOriginals = Map.of();
    private Map<String, Collection> developmentPreviews = Map.of(), developmentBanks = Map.of();
    private Map<String, ObjectNode> developmentUiBanks = Map.of();
    private Map<String, Path> bankPaths = Map.of();
    private ObjectNode catalog = Json.object();
    private String previousSignature = null;
    private record PreparedCollection(String id, String title, String description, String kind, Extension extension,
                                      List<Question> questions, BankFeatures features, String checkKey, CollectionValidation.Check checked) { }
    @FunctionalInterface private interface CollectionApplied { void accept(Collection collection) throws IOException; }
    private record PendingCollection(PreparedCollection prepared, java.util.function.Supplier<PreparedCollection> prepare,
                                     Runnable before, CollectionApplied applied, ObjectNode entry, String code, String description) { }
    // Only successful checks from the current catalog survive the next directory scan.
    private Map<String, CollectionValidation.Check> ruleChecks = Map.of();
    private String checksRunnerRevision = "";
    Library(Path root, RuleEngine engine) { this(root, root, engine); }
    Library(Path root, Path codeRoot, RuleEngine engine) { this(root, codeRoot, engine, settings(root)); }
    Library(Path root, Path codeRoot, RuleEngine engine, DevelopmentSettings developmentSettings) { this.root = root; this.codeRoot = codeRoot; this.engine = engine; resources = new ResourceStore(root); developmentResources = new ResourceStore(root.resolve(".development")); richText = new RichTextService(codeRoot); this.developmentSettings = developmentSettings; }
    private static DevelopmentSettings settings(Path root) { try { return new DevelopmentSettings(root); } catch (IOException e) { throw new ApiException(503, "DEVELOPMENT_SETTINGS_UNAVAILABLE", "Developer settings cannot be read"); } }

    ObjectNode index() { return new LibraryIndex(root, developmentSettings).scan().catalog(); }
    synchronized ObjectNode catalog() { refresh(); return new LibraryManagement(root).catalog(catalog); }
    synchronized ObjectNode manage(JsonNode request) throws IOException {
        ObjectNode outcome = new LibraryManagement(root).change(request, catalog());
        outcome.set("catalog", catalog()); return outcome;
    }
    synchronized LibraryArchive.Download exportGroup(String group) throws IOException {
        refresh();
        return new LibraryArchive(root, resources).exportGroup(group);
    }
    synchronized ObjectNode importArchive(java.io.InputStream input) throws IOException {
        try {
            return new LibraryArchive(root, resources).importPackage(input, staging -> {
                Library candidate = new Library(staging, codeRoot, engine, new DevelopmentSettings(staging));
                ObjectNode checked = candidate.catalog();
                for (String section : List.of("banks", "extensions")) for (JsonNode row : checked.path(section)) {
                    if (row.has("error")) throw new ApiException(422, "INVALID_LIBRARY_ARCHIVE", "导入校验失败：" + row.path("title").asText(row.path("name").asText(row.path("id").asText())) + "：" + row.path("error").asText());
                }
            });
        } finally { previousSignature = null; }
    }
    private java.util.function.Function<String, Collection> examCollections;
    void examCollections(java.util.function.Function<String, Collection> resolver) { examCollections = resolver; }
    Collection collection(String kind, String id) {
        if (kind.equals("exam") && examCollections != null) return examCollections.apply(id);
        synchronized (this) {
        refresh();
        if (kind.startsWith("development")) developmentSettings.requireEnabled();
        Map<String, Collection> values = switch (kind) { case "bank" -> banks; case "extension" -> previews; case "development" -> developmentPreviews; case "development-bank" -> developmentBanks; default -> throw ApiException.bad("Invalid collection kind"); };
        Collection collection = values.get(id);
        if (collection == null) throw new ApiException(404, "COLLECTION_NOT_FOUND", "Collection unavailable; inspect catalog errors");
        return collection;
        }
    }
    synchronized ObjectNode page(String id, String version) {
        refresh(); Extension extension = extensions.get(id + "@" + version);
        if (extension == null && developmentSettings.enabled()) extension = developmentExtensions.values().stream().filter(value -> value.id().equals(id) && value.version().equals(version)).findFirst().orElse(null);
        if (extension == null) throw new ApiException(404, "EXTENSION_NOT_FOUND", "Extension is unavailable");
        try { return snapshotPage(extension); }
        catch (IOException e) { throw new ApiException(422, "INVALID_EXTENSION", "Extension page is unavailable"); }
    }
    static ObjectNode snapshotPage(Extension extension) throws IOException {
        if (DevelopmentExtensions.runtimeMetadata(extension) != null) {
            ObjectNode config = developmentDeclaration(extension.directory());
            if (extension.script() == null) config.remove("script"); if (extension.style() == null) config.remove("style");
            ObjectNode page = Json.object().put("html", asset(extension.entry())).put("script", asset(extension.script())).put("style", asset(extension.style()));
            page.put("entryPath", extension.directory().relativize(extension.entry()).toString().replace('\\', '/'));
            if (extension.script() != null) page.put("scriptPath", extension.directory().relativize(extension.script()).toString().replace('\\', '/'));
            if (extension.style() != null) page.put("stylePath", extension.directory().relativize(extension.style()).toString().replace('\\', '/'));
            ArrayNode media = staticAssets(extension.directory(), config);
            if (!media.isEmpty()) page.set("assets", DevelopmentExtensions.page(extension.directory(), config, media).path("assets"));
            JsonNode marker = Json.read(Json.safeFile(extension.directory(), "development.json"), 256 * 1024);
            if (marker.path("mode").asText().equals("ui")) page.put("legacyPage", true);
            return withDependencies(page, extension);
        }
        JsonNode manifest = Json.read(Json.safeFile(extension.directory(), "manifest.json"), 256 * 1024);
        ArrayNode media = staticAssets(extension.directory(), manifest);
        ObjectNode page = media.isEmpty() ? Json.object().put("html", asset(extension.entry())).put("script", asset(extension.script())).put("style", asset(extension.style())) : DevelopmentExtensions.page(extension.directory(), manifest, media);
        return withDependencies(page, extension);
    }
    synchronized ObjectNode development(String folder) {
        developmentSettings.requireEnabled();
        try {
            refresh(); DevelopmentExtensions.Package value = developmentPackages.get(folder);
            if (value == null) throw new ApiException(404, "DEVELOPMENT_NOT_FOUND", "Development extension unavailable; inspect catalog errors");
            ObjectNode result = DevelopmentExtensions.descriptor(value);
            Extension extension = developmentExtensions.get(folder);
            if (extension == null || !developmentPreviews.containsKey(folder)) throw new ApiException(422, "INVALID_DEVELOPMENT_RUNTIME", "Development page or examples are invalid");
            result.set("page", snapshotPage(extension)); ObjectNode editor = editorPage(extension);
            result.put("canEdit", editor != null); if (editor != null) result.set("editor", editor);
            result.set("collection", Json.object().put("kind", "development").put("id", folder));
            result.set("extension", extensionReference(extension));
            result.set("features", developmentPreviews.get(folder).features().json());
            result.put("kind", "development").put("legacyPage", result.path("page").path("legacyPage").asBoolean());
            result.put("canEdit", editor != null && developmentPreviews.get(folder).features().editing());
            return result;
        } catch (IOException e) { throw new ApiException(422, "INVALID_DEVELOPMENT", "Development page is unavailable"); }
    }
    synchronized ObjectNode developmentBank(String id) {
        developmentSettings.requireEnabled();
        try {
            JsonNode raw = developmentBankSource(id); List<String> folders = developmentFolders(raw);
            Collection bank = collection("development-bank", id);
            ObjectNode result = folders.size() == 1 ? development(folders.getFirst()) : Json.object();
            result.put("id", id).put("kind", "development-bank").put("title", Json.text(raw, "title", 300));
            result.put("description", optional(raw, "description", 4000));
            result.set("development", bankDevelopmentMetadata(folders));
            ArrayNode used = result.putArray("extensions"); boolean canEdit = false;
            for (Extension extension : bank.extensions()) { used.add(extensionReference(extension)); canEdit |= editorPage(extension) != null; }
            result.set("features", bank.features().json()); result.put("canEdit", canEdit && bank.features().editing());
            result.set("collection", Json.object().put("kind", "development-bank").put("id", id));
            result.put("revision", developmentBankRevision(raw)); return result;
        } catch (IOException e) { throw new ApiException(422, "INVALID_DEVELOPMENT_BANK", "Development bank or preview page cannot be read"); }
    }
    private Path developmentDirectory(String folder) {
        if (folder == null || !folder.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,119}")) throw new ApiException(404, "DEVELOPMENT_NOT_FOUND", "Development extension is unavailable");
        List<Path> matches = ExtensionDirectories.scan(root.resolve("extensions")).stream().filter(DevelopmentExtensions::marked).filter(path -> path.getFileName().toString().equals(folder)).toList();
        if (matches.isEmpty()) throw new ApiException(404, "DEVELOPMENT_NOT_FOUND", "Development extension is unavailable");
        if (matches.size() != 1) throw ApiException.bad("Development leaf folder names must be globally unique");
        return matches.get(0);
    }
    private JsonNode developmentBankSource(String id) throws IOException {
        if (!id.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,119}")) throw ApiException.bad("Invalid bank ID");
        Path remembered = bankPaths.get(id); JsonNode raw = null;
        if (remembered != null && Files.isRegularFile(remembered, LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(remembered)) {
            raw = Json.read(Json.safeFile(root, root.relativize(remembered).toString().replace('\\', '/')), 8 * 1024 * 1024); if (raw == null || !raw.isObject() || !raw.path("id").asText().equals(id)) raw = null;
        }
        if (raw == null) for (Path file : bankFiles(root.resolve("question-banks"))) {
            JsonNode candidate; try { candidate = Json.read(Json.safeFile(root, root.relativize(file).toString().replace('\\', '/')), 8 * 1024 * 1024); } catch (IOException ignored) { continue; }
            if (candidate == null || !candidate.isObject()) continue;
            if (!candidate.path("id").asText().equals(id)) continue;
            if (raw != null) throw ApiException.bad("Duplicate bank ID"); raw = candidate;
        }
        if (raw == null || developmentFolders(raw).isEmpty()) throw new ApiException(404, "DEVELOPMENT_BANK_NOT_FOUND", "Development bank is unavailable");
        ExtensionApi.requireBank(raw); return raw;
    }
    synchronized ObjectNode developmentRevision(String folder) {
        developmentSettings.requireEnabled();
        Path directory = developmentDirectory(folder);
        try { return Json.object().put("revision", DevelopmentExtensions.revision(directory)); }
        catch (IOException e) { throw new ApiException(422, "INVALID_DEVELOPMENT", "Development revision cannot be read"); }
    }
    synchronized ObjectNode developmentBankRevision(String id) {
        developmentSettings.requireEnabled();
        try { return Json.object().put("revision", developmentBankRevision(developmentBankSource(id))); }
        catch (IOException e) { throw new ApiException(422, "INVALID_DEVELOPMENT_BANK", "Development bank is being edited or cannot be read"); }
    }
    private String developmentBankRevision(JsonNode raw) {
        List<String> folders = developmentFolders(raw);
        ArrayNode revisions = Json.MAPPER.createArrayNode();
        for (String folder : folders) revisions.add(Json.object().put("folder", folder).put("revision", developmentRevision(folder).path("revision").asText()));
        String revision = folders.size() == 1 ? revisions.get(0).path("revision").asText() : Json.fingerprint(revisions, "quizforge-development-bindings-v1");
        return bankDevelopmentRevision(Json.fingerprint(raw, "quizforge-development-bank-v1"), revision);
    }
    private static String bankDevelopmentRevision(String bankFingerprint, String revision) { return ResourceStore.hash((bankFingerprint + ":" + revision).getBytes(StandardCharsets.UTF_8)); }
    synchronized ObjectNode developmentPublishPlan(String folder) throws IOException {
        developmentSettings.requireEnabled(); refresh();
        DevelopmentExtensions.Package value = developmentPackages.get(folder);
        if (value == null || !value.mode().equals("runtime")) throw new ApiException(409, "DEVELOPMENT_NOT_READY", "Complete the runtime extension before publishing");
        String revision = DevelopmentExtensions.snapshotRevision(DevelopmentExtensions.snapshot(value.directory()));
        Extension original = validatePublication(value.directory());
        requirePublicationIdentity(original);
        String target = original.id() + "-" + original.version();
        if (target.length() > 120) target = original.id().substring(0, Math.min(80, original.id().length())) + "-" + ResourceStore.hash((original.id() + "@" + original.version()).getBytes(StandardCharsets.UTF_8)).substring(0, 16);
        String group = ExtensionDirectories.group(root.resolve("extensions"), value.directory()); if (!group.isEmpty()) target = group + "/" + target;
        if (Files.exists(root.resolve("extensions").resolve(target), LinkOption.NOFOLLOW_LINKS)) throw new ApiException(409, "PUBLISH_TARGET_EXISTS", "Publication directory already exists");
        if (!revision.equals(DevelopmentExtensions.snapshotRevision(DevelopmentExtensions.snapshot(value.directory())))) throw new ApiException(409, "DEVELOPMENT_CHANGED", "Development files changed during validation; review the publication again");
        String packageName = Json.text(Json.read(Json.safeFile(value.directory(), "manifest.json"), 256 * 1024), "name", 300);
        return Json.object().put("id", original.id()).put("version", original.version()).put("name", packageName).put("targetFolder", target).put("revision", revision).put("valid", true);
    }
    synchronized ObjectNode publishDevelopment(String folder, JsonNode request) throws IOException {
        if (request == null || !request.isObject() || request.size() != 1 || !request.path("revision").isTextual()) throw ApiException.bad("Publication requires the reviewed revision");
        ObjectNode plan = developmentPublishPlan(folder);
        if (!plan.path("revision").equals(request.path("revision"))) throw new ApiException(409, "DEVELOPMENT_CHANGED", "Development files changed since publication was reviewed");
        Path source = developmentPackages.get(folder).directory(), destination = root.resolve("extensions").resolve(plan.path("targetFolder").asText());
        Map<String, byte[]> snapshot = DevelopmentExtensions.snapshot(source);
        if (!plan.path("revision").asText().equals(DevelopmentExtensions.snapshotRevision(snapshot))) throw new ApiException(409, "DEVELOPMENT_CHANGED", "Development files changed while preparing publication");
        ObjectNode frozenManifest = (ObjectNode) Json.MAPPER.readTree(snapshot.get("manifest.json"));
        ArrayNode media = staticAssets(source, frozenManifest);
        if (!media.isEmpty()) { frozenManifest.set("assets", media); snapshot.put("manifest.json", Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsBytes(frozenManifest)); }
        Extension original = validatePublication(source);
        String examplesPath = source.relativize(original.examples()).toString().replace('\\', '/');
        JsonNode examples = Json.MAPPER.readTree(snapshot.get(examplesPath));
        snapshot.put(examplesPath, Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsBytes(DevelopmentExtensions.bindRuntimeExamples(examples, original, original)));
        Path temporaryRoot = root.resolve(".development/publishing");
        if (Files.isSymbolicLink(root.resolve(".development")) || Files.isSymbolicLink(temporaryRoot)) throw new IOException("Unsafe publication staging directory");
        Files.createDirectories(temporaryRoot); Path staged = Files.createTempDirectory(temporaryRoot, "package-");
        try {
            for (var file : snapshot.entrySet()) {
                if (file.getKey().equals("development.json")) continue;
                Path target = staged.resolve(file.getKey()).normalize(); if (!target.startsWith(staged)) throw new IOException("Unsafe publication path");
                Files.createDirectories(target.getParent()); Files.write(target, file.getValue());
            }
            Extension frozen = validatePublication(staged); requirePublicationIdentity(frozen);
            if (!plan.path("revision").asText().equals(DevelopmentExtensions.snapshotRevision(DevelopmentExtensions.snapshot(source)))) throw new ApiException(409, "DEVELOPMENT_CHANGED", "Development files changed during publication; review again");
            Files.move(staged, destination); previousSignature = null;
            return plan.put("published", true);
        } finally {
            if (!staged.toAbsolutePath().normalize().startsWith(temporaryRoot.toAbsolutePath().normalize())) throw new IOException("Unsafe publication cleanup path");
            if (Files.isDirectory(staged, LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(staged)) try (var files = Files.walk(staged)) {
                for (Path path : files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }
    private Extension validatePublication(Path directory) throws IOException {
        Extension original = extension(directory, Json.object());
        JsonNode raw = Json.read(original.examples(), 8 * 1024 * 1024); if (!Json.id(raw, "id").equals("examples")) throw ApiException.bad("Invalid example ID");
        raw = DevelopmentExtensions.bindRuntimeExamples(raw, original, original);
        var available = Map.of(original.id() + "@" + original.version(), original);
        Collection preview = parseResolvedCollection(raw, "extension", original, original.id(), available);
        editorPage(original); var inputs = new ArrayList<JsonNode>();
        for (Question question : preview.questions()) {
            ObjectNode input = Json.object(); input.set("data", question.data()); input.set("state", Json.object().put("status", "unanswered").putNull("answer").putNull("result")); inputs.add(input);
        }
        RuleBatches.run(engine, preview.questions(), "scoreBatch", "scores", inputs); return original;
    }
    private void requirePublicationIdentity(Extension original) {
        for (Path directory : ExtensionDirectories.scan(root.resolve("extensions"))) {
            if (DevelopmentExtensions.marked(directory)) continue;
            try {
                JsonNode manifest = Json.read(Json.safeFile(directory, "manifest.json"), 256 * 1024);
                if (manifest.path("id").asText().equals(original.id()) && manifest.path("version").asText().equals(original.version())) throw new ApiException(409, "EXTENSION_VERSION_EXISTS", "This formal extension ID and version already exist; choose a new version");
            } catch (IOException ignored) { }
        }
    }
    synchronized ObjectNode editorPage(Extension extension) {
        Path declaration = extension.directory().resolve("editor.json");
        try {
            boolean development = DevelopmentExtensions.runtimeMetadata(extension) != null;
            JsonNode marker = development ? Json.read(Json.safeFile(extension.directory(), "development.json"), 256 * 1024) : null;
            if (!Files.exists(declaration, LinkOption.NOFOLLOW_LINKS) && (marker == null || !marker.has("editor"))) return null;
            JsonNode config = Files.exists(declaration, LinkOption.NOFOLLOW_LINKS) ? Json.read(Json.safeFile(extension.directory(), "editor.json"), 256 * 1024) : marker.path("editor");
            JsonNode manifest = development ? developmentDeclaration(extension.directory()) : Json.read(Json.safeFile(extension.directory(), "manifest.json"), 256 * 1024);
            ArrayNode media = staticAssets(extension.directory(), manifest);
            ObjectNode page = development || !media.isEmpty() ? DevelopmentExtensions.page(extension.directory(), config, media) : Json.object().put("html", asset(Json.safeFile(extension.directory(), Json.text(config, "entry", 240)))).put("script", asset(Json.safeFile(extension.directory(), Json.text(config, "script", 240)))).put("style", asset(Json.safeFile(extension.directory(), Json.text(config, "style", 240))));
            if (marker != null && marker.path("mode").asText().equals("ui")) page.put("legacyPage", true);
            return withDependencies(page, extension);
        } catch (IOException | RuntimeException e) { throw new ApiException(422, "INVALID_EDITOR", "Extension editor declaration or assets are invalid"); }
    }
    private static ObjectNode withDependencies(ObjectNode page, Extension extension) {
        ExtensionApi.declare(page);
        if (extension.contentApi() != null) page.set("contentApi", extension.contentApi().deepCopy());
        if (!extension.dependencies().isEmpty()) {
            ArrayNode values = page.putArray("dependencies");
            for (Dependency dependency : extension.dependencies()) values.add(Json.object().put("id", dependency.id()).put("version", dependency.version()));
        }
        return page;
    }
    synchronized ObjectNode sdk(String id, String version) {
        return sdk(id, version, false);
    }
    synchronized ObjectNode sdk(String id, String version, boolean editor) {
        validateSdk(id, version);
        try {
            ObjectNode snapshot = resolveSdk(id, version);
            if (editor) return Json.object().put("script", snapshot.path("editorScript").asText());
            return Json.object().put("script", snapshot.path("script").asText()).put("style", snapshot.path("style").asText());
        } catch (IOException e) { throw new ApiException(404, "SDK_UNAVAILABLE", "Requested public SDK version is unavailable"); }
    }
    private RichTextService.Resolution dependencies(JsonNode manifest) throws IOException {
        RichTextService.Resolution resolution = richText.resolve(manifest);
        for (Dependency value : resolution.dependencies()) {
            try { resolveSdk(value.id(), value.version()); }
            catch (IOException e) { throw new ApiException(422, "SDK_UNAVAILABLE", "Public SDK " + value.id() + "@" + value.version() + " is unavailable: " + e.getMessage()); }
        }
        return resolution;
    }
    static void validateSdk(String id, String version) {
        if (!id.equals("quizforge.richtext") || !version.matches("[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}")) throw new ApiException(404, "SDK_UNAVAILABLE", "Unsupported public SDK package or version");
    }
    private ObjectNode resolveSdk(String id, String version) throws IOException {
        Path archive = sdkArchive(id, version, false);
        // Once published locally, the snapshot serves banks and frozen history.
        // Source rebuilds must never replace that version's installed assets.
        return Files.exists(archive, LinkOption.NOFOLLOW_LINKS) ? readSdkArchive(archive, id, version) : pinSdk(id, version);
    }
    private ObjectNode pinSdk(String id, String version) throws IOException {
        Path source = codeRoot.resolve("shared/richtext").resolve(version);
        if (Files.isSymbolicLink(codeRoot.resolve("shared")) || Files.isSymbolicLink(codeRoot.resolve("shared/richtext")) || Files.isSymbolicLink(source)) throw new IOException("Unsafe SDK directory");
        ObjectNode current = Json.object().put("id", id).put("version", version).put("script", asset(Json.safeFile(source, "richtext.js"))).put("editorScript", asset(Json.safeFile(source, "richtext-editor.js"))).put("style", asset(Json.safeFile(source, "richtext.css")));
        Path archive = sdkArchive(id, version, true);
        if (Files.exists(archive, LinkOption.NOFOLLOW_LINKS)) {
            ObjectNode stored = readSdkArchive(archive, id, version);
            if (!stored.equals(current)) throw new ApiException(409, "SDK_VERSION_CHANGED", "Public SDK versions are immutable; publish changes under a new version");
            return stored;
        }
        EditJournal.replace(archive, Json.MAPPER.writeValueAsBytes(current)); return current;
    }
    private Path sdkArchive(String id, String version, boolean create) throws IOException {
        Path current = root;
        for (String component : List.of(".state", "sdk", id, version)) {
            current = current.resolve(component);
            if (Files.isSymbolicLink(current) || (Files.exists(current, LinkOption.NOFOLLOW_LINKS) && !Files.isDirectory(current, LinkOption.NOFOLLOW_LINKS))) throw new IOException("Unsafe SDK archive directory");
            if (create) Files.createDirectories(current);
        }
        Path file = current.resolve("sdk.json"); if (Files.isSymbolicLink(file)) throw new IOException("Unsafe SDK archive"); return file;
    }
    private static ObjectNode readSdkArchive(Path path, String id, String version) throws IOException {
        JsonNode value = Json.read(path, 5 * 1024 * 1024);
        if (!value.isObject() || value.size() != 5 || !value.path("id").asText().equals(id) || !value.path("version").asText().equals(version) || !value.path("script").isTextual() || !value.path("editorScript").isTextual() || !value.path("style").isTextual() || value.path("script").asText().length() > 1024 * 1024 || value.path("editorScript").asText().length() > 1024 * 1024 || value.path("style").asText().length() > 1024 * 1024) throw new IOException("Invalid SDK archive");
        return (ObjectNode) value;
    }
    synchronized EditPlan prepareEdit(Collection current, String questionId, String title, JsonNode data) {
        current.features().requireEditing();
        Collection latest = collection(current.kind(), current.id());
        if (!latest.equals(current)) throw new ApiException(409, "CONTENT_CONFLICT", "Bank changed while preparing the edit");
        Path path = current.kind().equals("bank") || current.kind().equals("development-bank") ? bankPaths.get(current.id()) : current.extension().examples();
        if (path == null) throw new ApiException(422, "DEVELOPMENT_NOT_IMPLEMENTED", "请先创建样例题库文件，再保存题目编辑；当前输入已保留。");
        try {
            byte[] before = Files.readAllBytes(path); ObjectNode raw = (ObjectNode) Json.MAPPER.readTree(before);
            if (!parseEditCollection(raw, current).equals(current)) throw new ApiException(409, "CONTENT_CONFLICT", "Bank changed while reading the edit source");
            for (JsonNode item : raw.path("questions")) if (item.path("id").asText().equals(questionId)) {
                ((ObjectNode) item).put("title", title); ((ObjectNode) item).set("data", data.deepCopy());
            }
            Collection replacement = parseEditCollection(raw, current);
            if (current.kind().equals("extension") || current.kind().equals("development") || (path.getFileName().toString().equals("bank.json") && !path.getParent().equals(root.resolve("question-banks")))) (current.kind().startsWith("development") ? developmentResources : resources).exportReferences(path.getParent(), data);
            byte[] after = Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsBytes(raw);
            if (after.length > 8 * 1024 * 1024) throw new ApiException(413, "BANK_SIZE_LIMIT", "Bank exceeds the size limit");
            return new EditPlan(path, before, after, replacement, replacement.question(questionId));
        } catch (IOException e) { throw new ApiException(503, "BANK_UNAVAILABLE", "Bank cannot be prepared for editing"); }
    }
    private Collection parseEditCollection(JsonNode raw, Collection current) {
        JsonNode resolved = current.kind().equals("development") ? DevelopmentExtensions.bindRuntimeExamples(raw, developmentOriginals.get(current.id()), current.extension()) : raw;
        return parseCollection(resolved, current.kind(), current.extension(), current.id(), null);
    }
    synchronized EditPlan prepareShortAnswerUpgrade(Collection current) throws IOException {
        if (!current.kind().equals("bank") || current.extensions().stream().noneMatch(ShortAnswerUpgrade::eligible))
            throw ApiException.bad("Only installed short-answer 1.0.0, 1.1.0, 1.2.0 or 1.2.1 questions can use this upgrade");
        Collection latest = collection("bank", current.id());
        if (!latest.equals(current)) throw new ApiException(409, "CONTENT_CONFLICT", "Bank changed before upgrade");
        Extension target = shortAnswerUpgradeTarget();
        Path path = bankPaths.get(current.id()); byte[] before = Files.readAllBytes(path);
        ObjectNode raw = (ObjectNode) Json.MAPPER.readTree(before);
        if (!parseCollection(raw, "bank", current.extension(), current.id(), null).equals(current)) throw new ApiException(409, "CONTENT_CONFLICT", "Bank changed while reading upgrade source");
        JsonNode defaultReference = raw.get("extension");
        if (defaultReference != null && defaultReference.path("id").asText().equals("quizforge.short-answer")
                && java.util.Set.of("1.0.0", "1.1.0", "1.2.0", "1.2.1").contains(defaultReference.path("version").asText()))
            ((ObjectNode) defaultReference).put("version", target.version());
        for (JsonNode question : raw.path("questions")) {
            Extension previous = current.extensionFor(current.question(question.path("id").asText()));
            if (!ShortAnswerUpgrade.eligible(previous)) continue;
            if (question.has("extension")) ((ObjectNode) question.path("extension")).put("version", target.version());
            if (java.util.Set.of("1.0.0", "1.1.0").contains(previous.version())) {
                String title = question.path("title").asText().trim();
                ObjectNode stem = (ObjectNode) question.path("data").path("stem");
                ArrayNode content = (ArrayNode) stem.path("content");
                // The new view has one stem; retain the old separate title as rich text.
                if (!title.isEmpty() && (content.isEmpty() || !nodeText(content.get(0)).trim().equals(title))) {
                    ObjectNode heading = Json.object().put("type", "heading"); heading.putObject("attrs").put("level", 2);
                    heading.putArray("content").addObject().put("type", "text").put("text", title);
                    content.insert(0, heading);
                }
            }
        }
        Collection replacement = parseCollection(raw, "bank", current.extension() == null ? null : target, current.id(), null);
        byte[] after = Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsBytes(raw);
        if (after.length > 8 * 1024 * 1024) throw new ApiException(413, "BANK_SIZE_LIMIT", "Bank exceeds the size limit");
        return new EditPlan(path, before, after, replacement, null);
    }
    synchronized EditPlan prepareShortAnswerAutoUpgrade(Collection current) throws IOException {
        if (!current.kind().equals("bank") || current.extensions().stream().noneMatch(ShortAnswerAutoUpgrade::eligible))
            throw ApiException.bad("Only short-answer 1.2.2 questions can use this upgrade");
        if (!collection("bank", current.id()).equals(current)) throw new ApiException(409, "CONTENT_CONFLICT", "Bank changed before upgrade");
        Extension target = shortAnswerUpgradeTarget(ShortAnswerAutoUpgrade.TARGET_VERSION);
        Path path = bankPaths.get(current.id()); byte[] before = Files.readAllBytes(path);
        ObjectNode raw = (ObjectNode) Json.MAPPER.readTree(before);
        if (!parseCollection(raw, "bank", current.extension(), current.id(), null).equals(current))
            throw new ApiException(409, "CONTENT_CONFLICT", "Bank changed while reading upgrade source");
        if (ShortAnswerAutoUpgrade.eligible(current.extension())) ((ObjectNode) raw.path("extension")).put("version", target.version());
        for (JsonNode question : raw.path("questions"))
            if (question.has("extension") && ShortAnswerAutoUpgrade.eligible(current.extensionFor(current.question(question.path("id").asText()))))
                ((ObjectNode) question.path("extension")).put("version", target.version());
        Collection replacement = parseCollection(raw, "bank", current.extension() == null ? null : target, current.id(), null);
        byte[] after = Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsBytes(raw);
        if (after.length > 8 * 1024 * 1024) throw new ApiException(413, "BANK_SIZE_LIMIT", "Bank exceeds the size limit");
        return new EditPlan(path, before, after, replacement, null);
    }
    private Extension shortAnswerUpgradeTarget() { return shortAnswerUpgradeTarget(ShortAnswerUpgrade.TARGET_VERSION); }
    private Extension shortAnswerUpgradeTarget(String version) {
        for (JsonNode row : catalog.path("extensions")) {
            if (row.path("id").asText().equals("quizforge.short-answer") && row.path("version").asText().equals(version) && row.has("error"))
                throw new ApiException(row.path("errorStatus").asInt(422), row.path("errorCode").asText("INVALID_EXTENSION"), "Short-answer upgrade target " + version + " is unavailable: " + row.path("error").asText());
        }
        Extension target = extensions.get("quizforge.short-answer@" + version);
        if (target == null) throw new ApiException(422, "MISSING_EXTENSION", "Advanced short-answer " + version + " is not installed");
        return target;
    }
    private static String nodeText(JsonNode node) {
        if (node == null) return "";
        if (node.path("type").asText().equals("text")) return node.path("text").asText();
        StringBuilder value = new StringBuilder(); for (JsonNode child : node.path("content")) value.append(nodeText(child)); return value.toString();
    }
    private void refresh() {
        List<Path> extensionFolders = ExtensionDirectories.scan(root.resolve("extensions"));
        List<Path> bankFiles = bankFiles(root.resolve("question-banks"));
        String signature = signature(extensionFolders, bankFiles);
        if (signature.equals(previousSignature)) return;
        String runnerRevision = runnerRevision();
        if (!runnerRevision.equals(checksRunnerRevision)) ruleChecks = Map.of();
        var nextChecks = new HashMap<String, CollectionValidation.Check>();
        boolean transientRuleFailure = false;
        Map<String, Extension> nextExtensions = new LinkedHashMap<>();
        Map<String, Collection> nextBanks = new LinkedHashMap<>(), nextPreviews = new HashMap<>();
        Map<String, DevelopmentExtensions.Package> nextDevelopment = new LinkedHashMap<>();
        Map<String, Extension> nextDevelopmentExtensions = new HashMap<>(), nextDevelopmentOriginals = new HashMap<>();
        Map<String, Collection> nextDevelopmentPreviews = new HashMap<>(), nextDevelopmentBanks = new HashMap<>();
        Map<String, ObjectNode> nextUiBanks = new HashMap<>();
        Map<String, Path> nextBankPaths = new HashMap<>();
        var pending = new ArrayList<PendingCollection>();
        ArrayNode extensionCatalog = Json.MAPPER.createArrayNode(), bankCatalog = Json.MAPPER.createArrayNode();
        var developmentNames = new HashMap<String, Integer>(); for (Path folder : extensionFolders) if (DevelopmentExtensions.marked(folder)) developmentNames.merge(fallback(folder), 1, Integer::sum);
        for (Path folder : extensionFolders) {
            ObjectNode entry = Json.object().put("id", fallback(folder)).put("version", "?").put("name", fallback(folder)).put("description", "").put("questionCount", 0);
            entry.put("path", LibraryManagement.relative(root.resolve("extensions"), folder));
            String group = ExtensionDirectories.group(root.resolve("extensions"), folder); if (!group.isEmpty()) entry.put("group", group);
            if (DevelopmentExtensions.marked(folder)) {
                if (!developmentSettings.enabled()) continue;
                entry.put("kind", "development"); entry.set("development", Json.object().put("folder", fallback(folder)));
                try {
                    if (developmentNames.getOrDefault(fallback(folder), 0) != 1) throw ApiException.bad("Development leaf folder names must be globally unique");
                    DevelopmentExtensions.Package value = DevelopmentExtensions.read(folder);
                    nextDevelopment.put(value.folder(), value); entry.put("name", value.name()).put("title", value.name()).put("description", value.description()).put("revision", value.revision()).set("development", value.metadata());
                    Extension original = developmentExtension(value), extension = DevelopmentExtensions.runtime(original, value.folder(), value.revision());
                    JsonNode rawExamples = original.examples() == null ? defaultDevelopmentExample(value, original) : Json.read(original.examples(), 8 * 1024 * 1024);
                    if (!Json.id(rawExamples, "id").equals("examples")) throw ApiException.bad("Invalid example ID");
                    JsonNode example = DevelopmentExtensions.bindRuntimeExamples(rawExamples, original, extension);
                    var available = Map.of(extension.id() + "@" + extension.version(), extension, "development:" + value.folder(), extension);
                    PreparedCollection prepared = prepareCollection(example, "development", extension, value.folder(), available, nextChecks);
                    pending.add(new PendingCollection(prepared, null, null, preview -> {
                        developmentResources.importExtensionAssets(folder, staticAssets(folder, developmentDeclaration(folder)));
                        nextDevelopmentOriginals.put(value.folder(), original); nextDevelopmentExtensions.put(value.folder(), extension); nextDevelopmentPreviews.put(value.folder(), preview);
                        entry.put("questionCount", preview.questions().size()).put("version", original.version());
                        entry.set("features", preview.features().json()); entry.put("contentRevision", catalogRevision(preview));
                    }, entry, "INVALID_DEVELOPMENT", "Invalid development marker, page or runtime package"));
                } catch (Exception e) { transientRuleFailure |= transientRules(e); catalogError(entry, e, "INVALID_DEVELOPMENT", "Invalid development marker, page or runtime package"); }
                extensionCatalog.add(entry); continue;
            }
            try {
                Extension extension = extension(folder, entry);
                resources.importExtensionAssets(folder, staticAssets(folder, Json.read(Json.safeFile(folder, "manifest.json"), 256 * 1024)));
                String key = extension.id() + "@" + extension.version();
                if (nextExtensions.containsKey(key)) throw ApiException.bad("Duplicate extension version"); nextExtensions.put(key, extension);
                try {
                    JsonNode raw = Json.read(extension.examples(), 8 * 1024 * 1024); if (!Json.id(raw, "id").equals("examples")) throw ApiException.bad("Invalid example ID");
                    PreparedCollection prepared = prepareCollection(raw, "extension", extension, extension.id(), nextExtensions, nextChecks);
                    pending.add(new PendingCollection(prepared, null, null, preview -> {
                        entry.put("questionCount", preview.questions().size()); entry.set("features", preview.features().json());
                        entry.put("contentRevision", catalogRevision(preview)); Collection previous = nextPreviews.get(extension.id());
                        if (previous == null || compareVersion(extension.version(), previous.extensions().get(0).version()) > 0) nextPreviews.put(extension.id(), preview);
                    }, entry, "INVALID_EXTENSION_EXAMPLES", "Invalid extension examples or question data"));
                } catch (Exception e) { transientRuleFailure |= transientRules(e); catalogError(entry, e, "INVALID_EXTENSION_EXAMPLES", "Invalid extension examples or question data"); }
            } catch (Exception e) { catalogError(entry, e, "INVALID_EXTENSION", "Invalid extension manifest or declared assets"); }
            extensionCatalog.add(entry);
        }
        // Banks may only bind development packages whose preview was prepared successfully.
        transientRuleFailure |= applyPendingCollections(pending, nextChecks); pending.clear();
        var reservedBankIds = new HashSet<String>();
        for (Path file : bankFiles) {
            ObjectNode entry = Json.object().put("id", fallback(file).replaceFirst("\\.json$", "")).put("title", fallback(file)).put("description", "").put("questionCount", 0);
            Path bankItem = BankDirectories.item(root.resolve("question-banks"), file);
            entry.put("path", LibraryManagement.relative(root.resolve("question-banks"), bankItem));
            String group = LibraryManagement.relative(root.resolve("question-banks"), bankItem.getParent());
            if (!group.isEmpty()) entry.put("group", group);
            try {
                JsonNode raw = Json.read(file, 8 * 1024 * 1024);
                if (!developmentSettings.enabled() && hasDevelopmentReference(raw)) continue;
                ExtensionApi.requireBank(raw);
                BankFeatures bankFeatures = BankFeatures.read(raw); entry.set("features", bankFeatures.json());
                String id = Json.id(raw, "id"), title = Json.text(raw, "title", 300);
                entry.put("id", id).put("title", title).put("description", optional(raw, "description", 4000));
                List<String> devFolders = developmentFolders(raw); boolean developmentBank = !devFolders.isEmpty();
                if (developmentBank) {
                    if (!developmentSettings.enabled()) continue;
                    entry.put("kind", "development-bank"); entry.set("development", bankDevelopmentMetadata(devFolders));
                    for (String folder : devFolders) if (!nextDevelopment.containsKey(folder)) throw ApiException.bad("Missing development extension");
                }
                if (file.getFileName().toString().equals("bank.json") && !file.getParent().equals(root.resolve("question-banks"))) (developmentBank ? developmentResources : resources).importAssets(file.getParent());
                var available = new HashMap<>(nextExtensions); for (var value : nextDevelopmentExtensions.entrySet()) available.put("development:" + value.getKey(), value.getValue());
                Extension extension = raw.has("extension") ? resolveExtension(raw.get("extension"), available) : null;
                Runnable unique = () -> { if (nextBanks.containsKey(id) || nextDevelopmentBanks.containsKey(id) || nextUiBanks.containsKey(id)) throw ApiException.bad("Duplicate bank ID"); };
                java.util.function.Supplier<PreparedCollection> prepare = () -> prepareCollection(raw, developmentBank ? "development-bank" : "bank", extension, id, available, nextChecks);
                // A failed earlier bank does not claim its ID. Resolve later duplicates
                // individually after its result, preserving the existing scan order.
                PreparedCollection prepared = reservedBankIds.contains(id) ? null : prepare.get();
                reservedBankIds.add(id);
                pending.add(new PendingCollection(prepared, prepared == null ? prepare : null, unique, bank -> {
                    if (developmentBank) for (Extension value : bank.extensions()) {
                        JsonNode declaration = DevelopmentExtensions.runtimeMetadata(value) == null ? Json.read(Json.safeFile(value.directory(), "manifest.json"), 256 * 1024) : developmentDeclaration(value.directory());
                        developmentResources.importExtensionAssets(value.directory(), staticAssets(value.directory(), declaration));
                    }
                    if (bank.extension() == null) entry.putNull("extension"); else entry.set("extension", extensionReference(bank.extension()));
                    ArrayNode used = entry.putArray("extensions"); for (Extension value : bank.extensions()) used.add(extensionReference(value));
                    (developmentBank ? nextDevelopmentBanks : nextBanks).put(id, bank); nextBankPaths.put(id, file); entry.put("questionCount", bank.questions().size());
                    entry.put("contentRevision", catalogRevision(bank));
                }, entry, "INVALID_BANK", "Invalid bank JSON, extension reference, or question data"));
            } catch (Exception e) { transientRuleFailure |= transientRules(e); catalogError(entry, e, "INVALID_BANK", "Invalid bank JSON, extension reference, or question data"); }
            bankCatalog.add(entry);
        }
        transientRuleFailure |= applyPendingCollections(pending, nextChecks);
        // The preview route is keyed by type ID and opens its latest installed version.
        // Keep older packages addressable for bound banks/history, without duplicate preview rows.
        ArrayNode previewsCatalog = Json.MAPPER.createArrayNode();
        for (JsonNode entry : extensionCatalog) {
            Collection preview = nextPreviews.get(entry.path("id").asText());
            if (entry.path("kind").asText().equals("development") || entry.has("error") || preview == null || entry.path("version").asText().equals(preview.extensions().get(0).version())) previewsCatalog.add(entry);
        }
        catalog = Json.object(); catalog.set("banks", bankCatalog); catalog.set("extensions", previewsCatalog);
        extensions = Map.copyOf(nextExtensions); banks = Map.copyOf(nextBanks); bankPaths = Map.copyOf(nextBankPaths); previews = Map.copyOf(nextPreviews); previousSignature = transientRuleFailure ? null : signature;
        developmentPackages = Map.copyOf(nextDevelopment); developmentExtensions = Map.copyOf(nextDevelopmentExtensions); developmentOriginals = Map.copyOf(nextDevelopmentOriginals); developmentPreviews = Map.copyOf(nextDevelopmentPreviews); developmentBanks = Map.copyOf(nextDevelopmentBanks); developmentUiBanks = Map.copyOf(nextUiBanks);
        ruleChecks = Map.copyOf(nextChecks); checksRunnerRevision = runnerRevision;
    }
    private boolean applyPendingCollections(List<PendingCollection> pending, Map<String, CollectionValidation.Check> nextChecks) {
        var inputs = new ArrayList<List<Question>>();
        for (PendingCollection item : pending) inputs.add(item.prepared() == null || item.prepared().checked() != null ? null : item.prepared().questions());
        Map<Integer, RuntimeException> failures = CatalogRuleValidation.validate(engine, inputs);
        boolean transientFailure = false;
        for (int index = 0; index < pending.size(); index++) {
            PendingCollection item = pending.get(index);
            try {
                if (item.before() != null) item.before().run();
                PreparedCollection prepared = item.prepared() == null ? item.prepare().get() : item.prepared();
                Collection collection = finishCollection(prepared, nextChecks, item.prepared() != null, failures.get(index));
                item.applied().accept(collection);
            } catch (Exception failure) { transientFailure |= transientRules(failure); catalogError(item.entry(), failure, item.code(), item.description()); }
        }
        return transientFailure;
    }
    private static boolean transientRules(Exception failure) {
        return failure instanceof ApiException api && (api.code.equals("RULE_TIMEOUT") || api.code.equals("RULE_UNAVAILABLE"));
    }
    private static void catalogError(ObjectNode entry, Exception failure, String defaultCode, String description) {
        if (failure instanceof ApiException api) entry.put("error", api.getMessage()).put("errorCode", api.code).put("errorStatus", api.status);
        else entry.put("error", description + (failure.getMessage() == null ? "" : ": " + failure.getMessage())).put("errorCode", defaultCode).put("errorStatus", 422);
    }
    private static ObjectNode developmentDeclaration(Path directory) throws IOException {
        Path file = directory.resolve("manifest.json");
        JsonNode raw = Files.exists(file, LinkOption.NOFOLLOW_LINKS) ? Json.read(Json.safeFile(directory, "manifest.json"), 256 * 1024) : Json.object();
        if (!raw.isObject()) throw ApiException.bad("Invalid development manifest");
        ObjectNode config = (ObjectNode) raw.deepCopy();
        JsonNode marker = Json.read(Json.safeFile(directory, "development.json"), 256 * 1024);
        for (String field : List.of("entry", "script", "style", "rules", "questionSchema", "answerSchema", "examples")) if (!config.has(field) && marker.has(field)) config.set(field, marker.get(field));
        return config;
    }
    private Extension developmentExtension(DevelopmentExtensions.Package value) throws IOException {
        Path directory = value.directory(); ObjectNode config = developmentDeclaration(directory);
        if (config.has("types") || config.has("packageFormatVersion")) throw ApiException.bad("Each extension provides one question type; group independent extensions in folders");
        ExtensionApi.requireManifest(config);
        String id = config.has("id") ? Json.id(config, "id") : DevelopmentExtensions.runtimeId(value.folder());
        String version = config.has("version") ? Json.id(config, "version") : "0.0.0";
        String name = config.has("name") ? Json.text(config, "name", 300) : value.name();
        Path entry = developmentAsset(directory, config, "entry", true), script = developmentAsset(directory, config, "script", false), style = developmentAsset(directory, config, "style", false);
        Path rules = developmentAsset(directory, config, "rules", false), questionSchema = developmentAsset(directory, config, "questionSchema", false), answerSchema = developmentAsset(directory, config, "answerSchema", false), examples = developmentAsset(directory, config, "examples", false);
        // Optional files may be added later. Their absence must not prevent a valid page loading.
        for (String field : List.of("script", "style")) if ((field.equals("script") ? script : style) == null) config.remove(field);
        RichTextService.Resolution selected = dependencies(config);
        DevelopmentExtensions.page(directory, config, staticAssets(directory, config));
        return new Extension(id, version, name, value.description(), directory, entry, script, style, rules, questionSchema, answerSchema, examples,
                Json.fingerprint(config, "quizforge-development-source-v1"), selected.dependencies(), selected.contentApi(), selected.revision(), ExtensionApi.outlineItemsDeclared(config));
    }
    private static Path developmentAsset(Path directory, JsonNode declaration, String field, boolean required) throws IOException {
        if (!declaration.has(field)) { if (required) throw ApiException.bad("Development page requires an entry"); return null; }
        String relative = Json.text(declaration, field, 240); Path rel;
        try { rel = Path.of(relative); } catch (RuntimeException error) { throw new IOException("Invalid development asset path"); }
        Path base = directory.toRealPath(), file = base.resolve(rel).normalize();
        if (rel.isAbsolute() || relative.contains("\\") || relative.contains(":") || relative.contains("\0") || !file.startsWith(base)) throw new IOException("Invalid development asset path");
        Path segment = base;
        for (Path component : base.relativize(file)) { segment = segment.resolve(component); if (Files.isSymbolicLink(segment)) throw new IOException("Symlinks are not supported"); }
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS) && !required) return null;
        Path safe = Json.safeFile(directory, relative); if (Files.size(safe) > (field.equals("examples") ? 8 * 1024 * 1024 : 1024 * 1024)) throw new IOException("Asset size limit");
        return safe;
    }
    private static ObjectNode defaultDevelopmentExample(DevelopmentExtensions.Package value, Extension original) {
        ObjectNode raw = Json.object().put("id", "examples").put("title", value.name());
        raw.set("extension", Json.object().put("id", original.id()).put("version", original.version()));
        raw.putArray("questions").addObject().put("id", "preview").put("title", value.name()).set("data", Json.object()); return raw;
    }
    private Extension extension(Path folder, ObjectNode entry) throws IOException {
        JsonNode manifest = Json.read(Json.safeFile(folder, "manifest.json"), 256 * 1024);
        String id = Json.id(manifest, "id"), version = Json.id(manifest, "version");
        entry.put("id", id).put("version", version).put("name", Json.text(manifest, "name", 300)).put("description", optional(manifest, "description", 4000));
        if (manifest.has("types") || manifest.has("packageFormatVersion")) throw ApiException.bad("Each extension provides one question type; group independent extensions in folders");
        ExtensionApi.requireManifest(manifest);
        List<Path> assets = new ArrayList<>();
        for (String field : List.of("entry", "script", "style", "rules", "questionSchema", "answerSchema", "examples")) {
            Path asset = Json.safeFile(folder, Json.text(manifest, field, 240));
            int max = field.equals("examples") ? 8 * 1024 * 1024 : 1024 * 1024;
            if (Files.size(asset) > max) throw new IOException("Asset size limit"); assets.add(asset);
        }
        RichTextService.Resolution selected = dependencies(manifest);
        DevelopmentExtensions.page(folder, manifest, staticAssets(folder, manifest));
        return new Extension(id, version, Json.text(manifest, "name", 300), optional(manifest, "description", 4000), folder,
                assets.get(0), assets.get(1), assets.get(2), assets.get(3), assets.get(4), assets.get(5), assets.get(6), extensionFingerprint(folder, assets), selected.dependencies(), selected.contentApi(), selected.revision(), ExtensionApi.outlineItemsDeclared(manifest));
    }
    private static String extensionFingerprint(Path folder, List<Path> assets) throws IOException {
        try {
            var digest = java.security.MessageDigest.getInstance("SHA-256"); digest.update("quizforge-extension-v1".getBytes(StandardCharsets.UTF_8));
            var files = new ArrayList<Path>(); files.add(Json.safeFile(folder, "manifest.json")); files.addAll(assets.subList(0, 6));
            for (JsonNode item : staticAssets(folder, Json.read(files.get(0), 256 * 1024))) files.add(Json.safeFile(folder, item.asText()));
            for (Path file : files) { byte[] bytes = Files.readAllBytes(file); digest.update(java.nio.ByteBuffer.allocate(4).putInt(bytes.length).array()); digest.update(bytes); }
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    private static ArrayNode staticAssets(Path directory, JsonNode manifest) throws IOException {
        ArrayNode result = Json.MAPPER.createArrayNode(); var seen = new HashSet<String>();
        var declarations = new ArrayList<JsonNode>(); declarations.add(manifest.path("assets"));
        if (DevelopmentExtensions.marked(directory)) declarations.add(Json.read(Json.safeFile(directory, "development.json"), 256 * 1024).path("assets"));
        for (JsonNode declaration : declarations) {
            if (declaration.isMissingNode()) continue;
            if (!declaration.isArray()) throw ApiException.bad("Static assets must be a list of relative paths");
            for (JsonNode path : declaration) {
                if (!path.isTextual()) throw ApiException.bad("Invalid static asset path");
                if (seen.add(path.asText())) result.add(path.asText());
            }
        }
        if (result.size() > 100) throw ApiException.bad("Too many static assets"); return result;
    }
    private Collection parseCollection(Path file, String kind, Extension extension, String id, String requiredFileId) throws IOException {
        JsonNode raw = Json.read(file, 8 * 1024 * 1024);
        if (requiredFileId != null && !requiredFileId.equals(Json.id(raw, "id"))) throw ApiException.bad("Invalid example ID");
        return parseCollection(raw, kind, extension, id, (String) null);
    }
    private Collection parseCollection(JsonNode raw, String kind, Extension extension, String id, String ignored) {
        var available = new HashMap<>(extensions);
        for (var value : developmentExtensions.entrySet()) available.put("development:" + value.getKey(), value.getValue());
        if (extension != null) available.put(extension.id() + "@" + extension.version(), extension);
        return parseResolvedCollection(raw, kind, extension, id, available);
    }
    private Collection parseResolvedCollection(JsonNode raw, String kind, Extension extension, String id, Map<String, Extension> available) {
        return parseResolvedCollection(raw, kind, extension, id, available, null);
    }
    private Collection parseResolvedCollection(JsonNode raw, String kind, Extension extension, String id, Map<String, Extension> available, Map<String, CollectionValidation.Check> nextChecks) {
        return finishCollection(prepareCollection(raw, kind, extension, id, available, nextChecks), nextChecks, false, null);
    }
    private PreparedCollection prepareCollection(JsonNode raw, String kind, Extension extension, String id, Map<String, Extension> available, Map<String, CollectionValidation.Check> nextChecks) {
        var prepared = new CollectionValidation(engine).prepare(raw, kind, extension, id, available);
        String key = nextChecks == null ? null : prepared.checkKey();
        return new PreparedCollection(prepared.id(), prepared.title(), prepared.description(), prepared.kind(), prepared.extension(), prepared.questions(), prepared.features(), key, key == null ? null : ruleChecks.get(key));
    }
    private Collection finishCollection(PreparedCollection prepared, Map<String, CollectionValidation.Check> nextChecks, boolean validated, RuntimeException validationFailure) {
        var input = new CollectionValidation.Prepared(prepared.id(), prepared.title(), prepared.description(), prepared.kind(), prepared.extension(), prepared.questions(), prepared.features(), prepared.checkKey());
        var result = new CollectionValidation(engine).finish(input, prepared.checked(), validated, validationFailure);
        if (nextChecks != null && result.successfulCheck() != null) nextChecks.put(prepared.checkKey(), result.successfulCheck());
        return result.collection();
    }
    static String ruleIdentity(List<Question> questions) {
        ArrayNode owners = Json.MAPPER.createArrayNode();
        for (Question question : questions) {
            Extension value = question.extension();
            owners.add(Json.object().put("id", value.id()).put("version", value.version()).put("fingerprint", value.fingerprint())
                    .put("directory", value.directory().toString()).put("outlineItems", value.outlineItemsDeclared()));
        }
        return Json.fingerprint(owners, "quizforge-library-rules-v1");
    }
    private static String catalogRevision(Collection collection) {
        ObjectNode value = Json.object().put("title", collection.title()).put("description", collection.description()).put("stateKey", collection.stateKey());
        value.set("features", collection.features().json());
        ArrayNode questions = value.putArray("questions");
        for (Question question : collection.questions()) {
            ObjectNode row = questions.addObject().put("id", question.id()).put("title", question.title()).put("fingerprint", question.fingerprint())
                    .put("extensionId", question.extension().id()).put("extensionVersion", question.extension().version()).put("providerRevision", question.extension().providerRevision());
            row.set("outline", Json.MAPPER.valueToTree(question.outline()));
            row.set("outlineItems", Json.MAPPER.valueToTree(question.outlineItems()));
        }
        return Json.fingerprint(value, "quizforge-library-content-v1");
    }
    static boolean developmentRuleFailure(ApiException error) { return List.of("DEVELOPMENT_NOT_IMPLEMENTED", "RULE_REJECTED", "RULE_TIMEOUT", "RULE_UNAVAILABLE", "SCORE_UNAVAILABLE").contains(error.code); }
    static Extension resolveExtension(JsonNode reference, Map<String, Extension> available) {
        if (reference == null || !reference.isObject() || reference.has("typeId")) throw ApiException.bad("Extension references identify a single extension; typeId is unsupported");
        if (reference.has("development") && reference.size() != 1) throw ApiException.bad("Development extension references require only development");
        Extension value = reference.has("development") ? available.get("development:" + Json.id(reference, "development")) : available.get(Json.id(reference, "id") + "@" + Json.id(reference, "version"));
        if (value == null) throw ApiException.bad("Missing extension"); return value;
    }
    static boolean hasDevelopmentReference(JsonNode raw) {
        if (raw == null) return false;
        if (raw.path("extension").has("development")) return true;
        for (JsonNode question : raw.path("questions")) if (question.path("extension").has("development")) return true;
        return false;
    }
    static List<String> developmentFolders(JsonNode raw) {
        var folders = new HashSet<String>();
        if (raw.path("extension").has("development")) folders.add(Json.id(raw.path("extension"), "development"));
        for (JsonNode question : raw.path("questions")) if (question.path("extension").has("development")) {
            folders.add(Json.id(question.path("extension"), "development"));
        }
        return folders.stream().sorted().toList();
    }
    static ObjectNode bankDevelopmentMetadata(List<String> folders) {
        ObjectNode result = Json.object(); ArrayNode values = result.putArray("folders"); folders.forEach(values::add);
        if (folders.size() == 1) result.put("folder", folders.getFirst());
        return result;
    }
    private static ObjectNode extensionReference(Extension value) { ObjectNode result = Json.object().put("id", value.id()).put("version", value.version()); ObjectNode development = DevelopmentExtensions.runtimeMetadata(value); if (development != null) result.set("development", development); return result; }
    private static List<Path> children(Path directory, boolean jsonFiles, int limit) {
        if (!Files.exists(directory)) return List.of();
        if (Files.isSymbolicLink(directory) || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) throw new ApiException(422, "INVALID_LIBRARY", "Library directory must be a normal directory");
        try (var paths = Files.list(directory)) {
            List<Path> values = paths.filter(path -> !Files.isSymbolicLink(path)).filter(path -> jsonFiles ? Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) && path.getFileName().toString().endsWith(".json") : Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)).sorted().limit(limit + 1L).toList();
            if (values.size() > limit) throw new ApiException(422, "LIBRARY_LIMIT", "Library has too many entries"); return values;
        } catch (IOException e) { throw new ApiException(503, "LIBRARY_UNAVAILABLE", "Library directory cannot be read"); }
    }
    private static List<Path> bankFiles(Path directory) {
        return BankDirectories.scan(directory).banks();
    }
    private String signature(List<Path> folders, List<Path> banks) {
        StringBuilder signature = new StringBuilder().append("development:").append(developmentSettings.enabled());
        try {
            Path registry = richText.registryPath();
            if (Files.exists(registry, LinkOption.NOFOLLOW_LINKS)) stamp(signature, registry);
            for (Path folder : folders) {
                signature.append(folder).append(':');
                try {
                    if (DevelopmentExtensions.marked(folder)) { if (developmentSettings.enabled()) signature.append(DevelopmentExtensions.revision(folder)); continue; }
                    Path manifest = Json.safeFile(folder, "manifest.json"); stamp(signature, manifest);
                    JsonNode value = Json.read(manifest, 256 * 1024);
                    for (String field : List.of("entry", "script", "style", "rules", "questionSchema", "answerSchema", "examples")) stamp(signature, Json.safeFile(folder, Json.text(value, field, 240)));
                    for (JsonNode asset : staticAssets(folder, value)) stamp(signature, Json.safeFile(folder, asset.asText()));
                    for (Dependency dependency : richText.resolve(value).dependencies()) {
                        Path sdk = codeRoot.resolve("shared/richtext").resolve(dependency.version());
                        stamp(signature, Json.safeFile(sdk, "richtext.js")); stamp(signature, Json.safeFile(sdk, "richtext-editor.js")); stamp(signature, Json.safeFile(sdk, "richtext.css"));
                    }
                    stampAssets(signature, folder);
                } catch (IOException | RuntimeException e) { signature.append("invalid;"); }
            }
            for (Path path : banks) {
                stamp(signature, path);
                if (path.getFileName().toString().equals("bank.json") && !path.getParent().equals(root.resolve("question-banks"))) {
                    stampAssets(signature, path.getParent());
                }
            }
        } catch (IOException e) { signature.append("unreadable"); }
        return signature.toString();
    }
    private static void stampAssets(StringBuilder signature, Path directory) throws IOException {
        Path assets = directory.resolve("assets");
        if (Files.isDirectory(assets, LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(assets)) try (var entries = Files.walk(assets)) {
            for (Path file : entries.limit(1001).sorted().toList()) stamp(signature, file);
        }
    }
    private String runnerRevision() {
        StringBuilder revision = new StringBuilder();
        try { stamp(revision, Json.safeFile(codeRoot.resolve("server"), "rules-runner.cjs")); }
        catch (IOException | RuntimeException failure) { revision.append("unavailable"); }
        return revision.toString();
    }
    private static void stamp(StringBuilder signature, Path path) throws IOException { signature.append(path).append(':').append(Files.size(path)).append(':').append(Files.getLastModifiedTime(path)).append(';'); }
    static String optional(JsonNode raw, String field, int max) { if (!raw.has(field)) return ""; JsonNode value = raw.get(field); if (!value.isTextual() || value.asText().length() > max) throw ApiException.bad("Invalid " + field); return value.asText(); }
    private static String asset(Path path) throws IOException { if (path == null) return ""; if (Files.size(path) > 1024 * 1024) throw new IOException("Asset size limit"); return Files.readString(path, StandardCharsets.UTF_8); }
    private static String fallback(Path path) { String name = path.getFileName().toString(); return name.substring(0, Math.min(name.length(), 120)); }
    static int compareVersion(String left, String right) {
        String[] a = left.split("[.-]"), b = right.split("[.-]");
        for (int i = 0; i < Math.max(a.length, b.length); i++) { String x = i < a.length ? a[i] : "0", y = i < b.length ? b[i] : "0"; int comparison; try { comparison = new java.math.BigInteger(x).compareTo(new java.math.BigInteger(y)); } catch (NumberFormatException e) { comparison = x.compareTo(y); } if (comparison != 0) return comparison; }
        return 0;
    }
}

package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Library organization is independent of bank IDs, extension versions and saved practice. */
final class LibraryManagement {
    private final Path root;
    LibraryManagement(Path root) { this.root = root.toAbsolutePath().normalize(); }
    private Path base(String kind) { return root.resolve(kind.equals("bank") ? "question-banks" : "extensions"); }
    private Path labelsFile() { return root.resolve(".state/library-labels.json"); }
    private ObjectNode labels() throws IOException {
        Path path = labelsFile(); if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return Json.object();
        checkPath(path); JsonNode value = Json.read(path, 1024 * 1024);
        if (!value.isObject()) throw new IOException("Invalid library labels"); return (ObjectNode) value;
    }
    private static String labelKey(JsonNode row) { return row.path("kind").asText().equals("development") ? "development:" + row.path("id").asText() : row.path("id").asText() + "@" + row.path("version").asText(); }
    ObjectNode catalog(ObjectNode source) {
        try {
            ObjectNode result = source.deepCopy(), labels = labels(), groups = result.putObject("groups");
            for (String kind : List.of("bank", "extension")) {
                var values = groups.putArray(kind.equals("bank") ? "banks" : "extensions");
                for (Path group : groups(kind)) values.add(relative(base(kind), group));
            }
            for (JsonNode row : result.path("extensions")) {
                JsonNode label = labels.get(labelKey(row));
                if (label != null && label.isTextual()) { ((ObjectNode) row).put("name", label.asText()).put("displayName", label.asText()); if (row.has("title")) ((ObjectNode) row).put("title", label.asText()); }
            }
            return result;
        } catch (IOException e) { throw new ApiException(503, "LIBRARY_UNAVAILABLE", "无法读取目录设置"); }
    }
    private List<Path> groups(String kind) throws IOException {
        if (kind.equals("bank")) return BankDirectories.scan(base(kind)).groups();
        // Use the same leaf definition as the extension loader, including incomplete development leaves.
        List<Path> leaves = ExtensionDirectories.scan(base(kind)); var result = new ArrayList<Path>();
        if (!Files.exists(base(kind), LinkOption.NOFOLLOW_LINKS)) return result;
        collectGroups(base(kind), leaves, result); return result;
    }
    private static void collectGroups(Path directory, List<Path> leaves, List<Path> result) throws IOException {
        try (var paths = Files.list(directory)) {
            for (Path child : paths.sorted().toList()) if (Files.isDirectory(child, LinkOption.NOFOLLOW_LINKS) && !leaves.contains(child)) { checkPath(child); result.add(child); }
        }
    }
    ObjectNode change(JsonNode request, ObjectNode catalog) throws IOException {
        String kind = Json.text(request, "kind", 20), action = Json.text(request, "action", 20), target = Json.text(request, "target", 20);
        if (!List.of("bank", "extension").contains(kind) || !List.of("create", "update", "delete").contains(action) || !List.of("item", "group").contains(target)) throw ApiException.bad("Invalid library operation");
        for (var names = request.fieldNames(); names.hasNext();) if (!Set.of("kind", "action", "target", "path", "name", "group").contains(names.next())) throw ApiException.bad("Unknown library field");
        Path base = base(kind); checkPath(base);
        if (action.equals("create") && !target.equals("group")) throw ApiException.bad("Only groups can be created here");
        String path = action.equals("create") ? "" : Json.text(request, "path", 1000);
        Path source = path.isEmpty() ? null : resolve(base, path); JsonNode row = null;
        if (source != null) {
            if (target.equals("group")) { if (!groups(kind).contains(source)) throw new ApiException(404, "GROUP_NOT_FOUND", "分组已不存在，请刷新列表"); }
            else { for (JsonNode candidate : catalog.path(kind.equals("bank") ? "banks" : "extensions")) if (candidate.path("path").asText().equals(path)) { row = candidate; break; }
                if (row == null) throw new ApiException(404, "ITEM_NOT_FOUND", "目录项目已不存在，请刷新列表"); }
            checkTree(source);
        }
        if (action.equals("delete")) {
            if (kind.equals("extension")) requireUnused(source);
            Path trash = root.resolve(".trash"); safeCreate(trash); safeCreate(trash.resolve("library"));
            Path receipt = trash.resolve("library").resolve(UUID.randomUUID().toString()); Files.createDirectory(receipt);
            ObjectNode record = Json.object().put("kind", kind).put("target", target).put("path", path).put("deletedAt", java.time.Instant.now().toString());
            Files.write(receipt.resolve("receipt.json"), Json.MAPPER.writeValueAsBytes(record));
            Files.createDirectory(receipt.resolve("content"));
            Files.move(source, receipt.resolve("content").resolve(source.getFileName()));
            return Json.object().put("archivedTo", relative(root, receipt));
        }
        String name = Json.text(request, "name", 300).strip(); if (name.isBlank()) throw ApiException.bad("名称不能为空");
        String group = request.has("group") ? request.path("group").asText() : "";
        if (request.has("group") && !request.path("group").isTextual()) throw ApiException.bad("Invalid group");
        if (target.equals("group") && !group.isEmpty()) throw ApiException.bad("分组只支持一层，不能移入其他分组");
        Path parent = group.isEmpty() ? base : resolve(base, group);
        if (!parent.equals(base) && !groups(kind).contains(parent)) throw ApiException.bad("请选择现有分组");
        Path destination;
        if (target.equals("group")) {
            folderName(name); destination = parent.resolve(name);
        } else {
            // bank.json is the package marker. A standalone file needs an ordinary
            // JSON filename when moved into a group, otherwise the group becomes a bank.
            String filename = source.getFileName().toString();
            if (kind.equals("bank") && Files.isRegularFile(source) && filename.equals("bank.json") && !parent.equals(base)) filename = row.path("id").asText("bank") + ".questions.json";
            destination = parent.resolve(filename);
        }
        if (!destination.equals(source) && Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) throw new ApiException(409, "LIBRARY_TARGET_EXISTS", "目标分组已有同名文件或文件夹");
        if (source == null) {
            int count = groups(kind).size() + (kind.equals("extension") ? ExtensionDirectories.scan(base).size() : 0);
            if (count >= 1000) throw ApiException.bad("目录数量已达到上限");
            Files.createDirectory(destination); return Json.object();
        }
        byte[] before = null, after = null; Path nameFile = null; ObjectNode updatedLabels = null;
        if (target.equals("item")) {
            if (kind.equals("bank")) {
                nameFile = Files.isDirectory(source) ? source.resolve("bank.json") : source; checkPath(nameFile);
                ObjectNode raw = (ObjectNode) Json.read(nameFile, 8 * 1024 * 1024); before = Files.readAllBytes(nameFile); raw.put("title", name);
                after = Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsBytes(raw);
            } else { updatedLabels = labels(); updatedLabels.put(labelKey(row), name); }
        }
        if (after != null) EditJournal.replace(nameFile, after);
        try { if (!source.equals(destination)) Files.move(source, destination); }
        catch (IOException error) { if (before != null) EditJournal.replace(nameFile, before); throw error; }
        if (updatedLabels != null) {
            try { checkPath(labelsFile().getParent()); EditJournal.replace(labelsFile(), Json.MAPPER.writeValueAsBytes(updatedLabels)); }
            catch (IOException error) { if (!source.equals(destination)) Files.move(destination, source); throw error; }
        }
        return Json.object().put("path", relative(base, destination));
    }
    private void requireUnused(Path removed) throws IOException {
        var formal = new HashSet<String>(); var development = new HashSet<String>();
        for (Path extension : ExtensionDirectories.scan(base("extension"))) if (extension.startsWith(removed)) {
            if (DevelopmentExtensions.marked(extension)) development.add(extension.getFileName().toString());
            else { JsonNode manifest = Json.read(Json.safeFile(extension, "manifest.json"), 256 * 1024); formal.add(manifest.path("id").asText() + "@" + manifest.path("version").asText()); }
        }
        var used = new ArrayList<String>();
        for (Path bank : BankDirectories.scan(base("bank")).banks()) {
            JsonNode raw;
            try { raw = Json.read(bank, 8 * 1024 * 1024); }
            catch (IOException error) { throw new ApiException(409, "BANK_DEPENDENCIES_UNKNOWN", "请先修复无法读取的题库，再删除拓展：" + relative(base("bank"), bank)); }
            boolean matches = referenceUsed(raw.path("extension"), formal, development);
            for (JsonNode question : raw.path("questions")) matches |= referenceUsed(question.path("extension"), formal, development);
            if (matches) used.add(raw.path("title").asText(relative(base("bank"), bank)));
        }
        if (!used.isEmpty()) throw new ApiException(409, "EXTENSION_IN_USE", "仍被以下题库使用，不能删除：" + String.join("、", used));
    }
    private static boolean referenceUsed(JsonNode reference, Set<String> formal, Set<String> development) { return formal.contains(reference.path("id").asText() + "@" + reference.path("version").asText()) || development.contains(reference.path("development").asText()); }
    static String relative(Path base, Path value) { return base.relativize(value).toString().replace('\\', '/'); }
    private static Path resolve(Path base, String path) throws IOException {
        if (path.contains("\\") || path.contains(":") || path.contains("\0")) throw ApiException.bad("Invalid library path");
        Path value;
        try { value = Path.of(path); } catch (RuntimeException error) { throw ApiException.bad("Invalid library path"); }
        if (value.isAbsolute()) throw ApiException.bad("Invalid library path");
        for (Path part : value) if (part.toString().equals(".") || part.toString().equals("..") || part.toString().isEmpty()) throw ApiException.bad("Invalid library path");
        Path candidate = base.resolve(value).normalize(); if (candidate.equals(base) || !candidate.startsWith(base)) throw ApiException.bad("Invalid library path");
        Path current = base; for (Path part : value) { current = current.resolve(part); checkPath(current); } return candidate;
    }
    static void checkPath(Path value) throws IOException {
        Path absolute = value.toAbsolutePath().normalize();
        if (Files.isSymbolicLink(absolute) || !absolute.toRealPath().equals(absolute)) throw new IOException("目录不能包含链接或重定向路径");
    }
    private static void checkTree(Path value) throws IOException {
        checkPath(value); if (!Files.isDirectory(value, LinkOption.NOFOLLOW_LINKS)) return;
        try (var paths = Files.walk(value)) { var entries = paths.limit(20001).toList(); if (entries.size() > 20000) throw ApiException.bad("目录文件过多，无法安全移动"); for (Path entry : entries) checkPath(entry); }
    }
    private static void safeCreate(Path directory) throws IOException { if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) Files.createDirectory(directory); checkPath(directory); }
    static void folderName(String name) {
        if (Set.of("bank.json", "manifest.json", "development.json").contains(name.toLowerCase(java.util.Locale.ROOT))) throw ApiException.bad("此名称用于题库或拓展文件，不能作为分组名称");
        if (name.length() > 120 || name.matches(".*[\\\\/:*?\"<>|\\p{Cntrl}].*") || name.endsWith(".") || name.equals(".") || name.equals("..") || name.matches("(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\\..*)?")) throw ApiException.bad("分组名称不能包含路径、特殊字符或 Windows 保留名称");
    }
}

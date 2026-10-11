package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Versioned .qbank transport: bank and extension identities remain in their original documents. */
final class LibraryArchive {
    static final long MAX_UPLOAD = 64L * 1024 * 1024, MAX_EXPANDED = 128L * 1024 * 1024;
    private static final long MAX_FILE = 8L * 1024 * 1024;
    private static final int MAX_ENTRIES = 10000;
    private final Path root;
    private final ResourceStore resources;
    private long copiedBytes;
    private int copiedEntries;
    static final String MANIFEST = "quizforge-package.json", FORMAT = "quizforge-bank-group";
    static final String MIME = "application/vnd.quizforge.qbank";
    interface Validator { void validate(Path staging) throws IOException; }
    record Download(Path workspace, Path file) implements AutoCloseable {
        public void close() throws IOException { removeWorkspace(workspace); }
    }
    private record Move(Path source, Path destination) { }
    LibraryArchive(Path root, ResourceStore resources) { this.root = root.toAbsolutePath().normalize(); this.resources = resources; }

    Download exportGroup(String group) throws IOException {
        LibraryManagement.folderName(group);
        Path bankRoot = root.resolve("question-banks"), selected = bankRoot.resolve(group);
        if (!BankDirectories.scan(bankRoot).groups().contains(selected)) throw new ApiException(404, "GROUP_NOT_FOUND", "题库分组已不存在，请刷新列表");
        Path work = workspace();
        try {
            Path content = work.resolve("content"), banks = content.resolve("question-banks").resolve(group), extensions = content.resolve("extensions").resolve(group);
            Files.createDirectories(banks); Files.createDirectories(extensions);
            Map<String, Path> installed = extensionIndex(root.resolve("extensions"));
            var required = new java.util.LinkedHashSet<String>(); var ids = new HashSet<String>();
            for (Path file : BankDirectories.scan(bankRoot).banks()) {
                if (!file.startsWith(selected)) continue;
                JsonNode bank = Json.read(file, (int) MAX_FILE); String id = Json.id(bank, "id");
                if (!ids.add(id)) throw invalid("分组内有重复题库 ID：" + id);
                collectBindings(bank, required);
                Path destination = banks.resolve(id); copyBank(file, destination);
            }
            for (String identity : required) {
                Path source = installed.get(identity);
                if (source == null) throw invalid("缺少正式拓展：" + identity + "；引用开发版的题库需先完成拓展发布");
                copyExtension(source, extensions.resolve(identity));
            }
            Files.write(content.resolve(MANIFEST), Json.MAPPER.writeValueAsBytes(Json.object().put("format", FORMAT).put("formatVersion", 1).put("group", group)));
            Path zip = work.resolve("group.qbank"); zip(content, zip);
            if (Files.size(zip) > MAX_UPLOAD) throw limit("导出的题库包超过 64 MiB，请缩小题库分组");
            return new Download(work, zip);
        } catch (IOException | RuntimeException error) { removeWorkspace(work); throw error; }
    }

    ObjectNode importPackage(InputStream input, Validator validator) throws IOException {
        Path work = workspace();
        try {
            Path zip = work.resolve("upload.qbank"), staging = work.resolve("content");
            try (OutputStream output = Files.newOutputStream(zip)) { transfer(input, output, MAX_UPLOAD); }
            Files.createDirectory(staging); unzip(zip, staging);
            String group = archiveGroup(staging);
            var incomingBanks = BankDirectories.scan(staging.resolve("question-banks")).banks();
            var incomingExtensions = ExtensionDirectories.scan(staging.resolve("extensions"));
            // Formal-only transport keeps unfinished developer source out of ordinary installations.
            for (Path extension : incomingExtensions) if (DevelopmentExtensions.marked(extension)) throw invalid("第一版题库包导入只支持正式拓展，请先完成拓展发布");
            try { validatePrivatePaths(staging, incomingBanks, incomingExtensions); }
            catch (IOException error) { throw invalid("题库包的拓展文件声明无效或不完整"); }
            catch (ApiException error) { if (error.status == 400) throw invalid("题库包的拓展文件声明无效或不完整"); throw error; }
            try { validator.validate(staging); } catch (IOException error) { throw invalid("题库包内容无法读取，请重新导出"); }
            ResourceStore stagedResources = new ResourceStore(staging);
            for (Path bank : incomingBanks) stagedResources.exportReferences(bank.getParent(), Json.read(bank, (int) MAX_FILE));
            for (Path extension : incomingExtensions) {
                JsonNode manifest = Json.read(extension.resolve("manifest.json"), 256 * 1024);
                Path examples = Json.safeFile(extension, Json.text(manifest, "examples", 240));
                stagedResources.exportReferences(examples.getParent(), Json.read(examples, (int) MAX_FILE));
            }
            Map<String, Path> localBanks = bankIndex(root.resolve("question-banks")), localExtensions = extensionIndex(root.resolve("extensions"));
            Map<String, Path> newBanks = bankIndex(staging.resolve("question-banks")), newExtensions = extensionIndex(staging.resolve("extensions"));
            var moves = new ArrayList<Move>(); int skippedBanks = 0, skippedExtensions = 0;
            Path targetBanks = root.resolve("question-banks").resolve(group), targetExtensions = root.resolve("extensions").resolve(group);
            // Do not turn a standalone bank/extension leaf into a group by writing inside it.
            checkGroupDestination("bank", targetBanks); checkGroupDestination("extension", targetExtensions);
            for (var entry : newBanks.entrySet()) {
                Path sourceFile = entry.getValue(), source = BankDirectories.item(staging.resolve("question-banks"), sourceFile), existing = localBanks.get(entry.getKey());
                if (existing != null) {
                    Path normalized = work.resolve("compare-bank-" + skippedBanks); copyBank(existing, normalized);
                    Path candidate = work.resolve("incoming-bank-" + skippedBanks); new LibraryArchive(staging, new ResourceStore(staging)).copyBank(sourceFile, candidate);
                    if (!sameTree(normalized, candidate)) throw conflict("题库 ID 相同但内容不同：" + entry.getKey());
                    skippedBanks++; continue;
                }
                Path destination = targetBanks.resolve(source.getFileName()); checkDestination(destination); moves.add(new Move(source, destination));
            }
            for (var entry : newExtensions.entrySet()) {
                Path source = entry.getValue(), existing = localExtensions.get(entry.getKey());
                if (existing != null) {
                    Path normalized = work.resolve("compare-extension-" + skippedExtensions); copyExtension(existing, normalized);
                    if (!sameTree(normalized, source)) throw conflict("拓展 ID 和版本相同但内容不同：" + entry.getKey());
                    skippedExtensions++; continue;
                }
                Path destination = targetExtensions.resolve(source.getFileName()); checkDestination(destination); moves.add(new Move(source, destination));
            }
            // Validation and every conflict check finish before touching either installed directory.
            var created = new ArrayList<Path>(); var committed = new ArrayList<Move>();
            try {
                for (Path directory : List.of(root.resolve("question-banks"), root.resolve("extensions"), targetBanks, targetExtensions)) {
                    if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) { Files.createDirectory(directory); created.add(directory); }
                    LibraryManagement.checkPath(directory);
                }
                for (Move move : moves) { Files.move(move.source(), move.destination()); committed.add(move); }
            } catch (IOException | RuntimeException error) {
                for (int index = committed.size() - 1; index >= 0; index--) {
                    Move move = committed.get(index); try { Files.move(move.destination(), move.source()); } catch (IOException rollback) { error.addSuppressed(rollback); }
                }
                for (int index = created.size() - 1; index >= 0; index--) try { Files.delete(created.get(index)); } catch (IOException rollback) { error.addSuppressed(rollback); }
                throw error;
            }
            return Json.object().put("group", group).put("importedBanks", newBanks.size() - skippedBanks).put("importedExtensions", newExtensions.size() - skippedExtensions)
                    .put("skippedBanks", skippedBanks).put("skippedExtensions", skippedExtensions);
        } catch (java.util.zip.ZipException error) { throw invalid("压缩包损坏或不是有效的 ZIP 文件"); }
        finally { removeWorkspace(work); }
    }

    private void checkGroupDestination(String kind, Path destination) throws IOException {
        if (!Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) return;
        LibraryManagement.checkPath(destination);
        boolean group = kind.equals("bank") ? BankDirectories.scan(root.resolve("question-banks")).groups().contains(destination)
                : Files.isDirectory(destination) && !Files.exists(destination.resolve("manifest.json")) && !Files.exists(destination.resolve("development.json"));
        if (!group) throw conflict("分组名称与现有题库或拓展目录冲突：" + destination.getFileName());
    }
    private static void checkDestination(Path destination) {
        if (Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) throw conflict("目标分组已有同名文件或目录：" + destination.getFileName());
    }
    private static void collectBindings(JsonNode bank, Set<String> required) {
        if (bank.has("extension")) required.add(binding(bank.get("extension")));
        for (JsonNode question : bank.path("questions")) if (question.has("extension")) required.add(binding(question.get("extension")));
    }
    private static String binding(JsonNode reference) {
        if (reference.has("development")) throw invalid("题库引用开发版拓展，请先完成拓展发布再导出");
        return Json.id(reference, "id") + "@" + Json.id(reference, "version");
    }
    private static Map<String, Path> bankIndex(Path directory) throws IOException {
        var values = new LinkedHashMap<String, Path>();
        for (Path file : BankDirectories.scan(directory).banks()) {
            String id = Json.id(Json.read(file, (int) MAX_FILE), "id");
            if (values.putIfAbsent(id, file) != null) throw conflict("有重复题库 ID：" + id);
        }
        return values;
    }
    private static Map<String, Path> extensionIndex(Path directory) throws IOException {
        var values = new LinkedHashMap<String, Path>();
        for (Path leaf : ExtensionDirectories.scan(directory)) {
            if (DevelopmentExtensions.marked(leaf)) continue;
            JsonNode manifest = Json.read(leaf.resolve("manifest.json"), 256 * 1024); String id = binding(manifest);
            if (values.putIfAbsent(id, leaf) != null) throw conflict("有重复拓展 ID 和版本：" + id);
        }
        return values;
    }
    private void copyBank(Path file, Path destination) throws IOException {
        if (file.getFileName().toString().equals("bank.json") && !file.getParent().equals(root.resolve("question-banks"))) copyTree(file.getParent(), destination);
        else { Files.createDirectories(destination); accountCopy(file); Files.copy(file, destination.resolve("bank.json")); }
        exportImages(destination, Json.read(destination.resolve("bank.json"), (int) MAX_FILE));
    }
    private void copyExtension(Path source, Path destination) throws IOException {
        copyTree(source, destination, declaredExtensionPaths(source));
        JsonNode manifest = Json.read(destination.resolve("manifest.json"), 256 * 1024);
        Path examples = Json.safeFile(destination, Json.text(manifest, "examples", 240));
        exportImages(examples.getParent(), Json.read(examples, (int) MAX_FILE));
    }
    private void copyTree(Path source, Path destination) throws IOException {
        copyTree(source, destination, Set.of());
    }
    private void copyTree(Path source, Path destination, Set<Path> declaredPaths) throws IOException {
        LibraryManagement.checkPath(source);
        try (var stream = Files.walk(source)) {
            var files = stream.limit(MAX_ENTRIES + 1L).toList(); if (files.size() > MAX_ENTRIES) throw limit("目录文件数量超过上限");
            for (Path file : files) {
                Path relative = source.relativize(file); if (privatePath(relative) && !declaredPaths.contains(relative)) continue;
                if (++copiedEntries > MAX_ENTRIES) throw limit("复制文件数量超过上限");
                LibraryManagement.checkPath(file); Path target = destination.resolve(relative.toString());
                if (Files.isDirectory(file, LinkOption.NOFOLLOW_LINKS)) Files.createDirectories(target);
                else { if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_FILE) throw limit("目录中有过大的文件：" + relative); accountCopy(file); Files.copy(file, target); }
            }
        }
    }
    private void exportImages(Path directory, JsonNode document) throws IOException {
        var ids = new HashSet<String>(); imageReferences(document, ids);
        for (String id : ids) {
            ResourceStore.Resource image = resources.read(id);
            // Reserve capacity before ResourceStore materializes cache-only images.
            String suffix = Map.of("image/png", "png", "image/jpeg", "jpg", "image/gif", "gif", "image/webp", "webp").get(image.mime());
            if (Files.exists(directory.resolve("assets").resolve(id + "." + suffix))) continue;
            copiedBytes += image.bytes().length;
            if (copiedBytes > MAX_EXPANDED || ++copiedEntries > MAX_ENTRIES) throw limit("图片及文件超过导出大小或数量上限");
        }
        resources.exportReferences(directory, document);
    }
    private static void imageReferences(JsonNode value, Set<String> ids) {
        if (value.isObject()) {
            if (value.path("type").asText().equals("image") && value.path("attrs").has("assetId")) ids.add(value.path("attrs").path("assetId").asText());
            for (JsonNode child : value) imageReferences(child, ids);
        } else if (value.isArray()) for (JsonNode child : value) imageReferences(child, ids);
    }
    private void accountCopy(Path file) throws IOException {
        copiedBytes += Files.size(file);
        if (copiedBytes > MAX_EXPANDED) throw limit("复制内容超过 128 MiB，请缩小题库分组");
    }
    private static boolean privatePath(Path relative) {
        for (Path segment : relative) if (segment.toString().startsWith(".") || Set.of("node_modules", "target").contains(segment.toString())) return true;
        return false;
    }
    /** Manifest-owned files remain transportable even when their names begin with a dot. */
    private static Set<Path> declaredExtensionPaths(Path extension) throws IOException {
        var declared = new HashSet<Path>();
        JsonNode manifest = Json.read(Json.safeFile(extension, "manifest.json"), 256 * 1024);
        if (manifest == null || !manifest.isObject()) throw invalid("题库包的拓展清单无效");
        for (String field : List.of("entry", "script", "style", "rules", "questionSchema", "answerSchema", "examples"))
            permitPath(extension, Json.text(manifest, field, 240), declared);
        for (JsonNode asset : manifest.path("assets")) permitPath(extension, asset.asText(), declared);
        Path editor = extension.resolve("editor.json");
        if (Files.exists(editor, LinkOption.NOFOLLOW_LINKS)) {
            JsonNode config = Json.read(Json.safeFile(extension, "editor.json"), 256 * 1024);
            if (config == null || !config.isObject()) throw invalid("题库包的编辑器声明无效");
            for (String field : List.of("entry", "script", "style")) permitPath(extension, Json.text(config, field, 240), declared);
        }
        return Set.copyOf(declared);
    }
    private static void permitPath(Path extension, String name, Set<Path> declared) throws IOException {
        Path path = extension.relativize(Json.safeFile(extension, name));
        for (; path != null; path = path.getParent()) declared.add(path);
    }
    private static void validatePrivatePaths(Path staging, List<Path> banks, List<Path> extensions) throws IOException {
        var leaves = new HashSet<Path>(); var declared = new HashSet<Path>();
        for (Path extension : extensions) {
            leaves.add(extension);
            for (Path relative : declaredExtensionPaths(extension)) declared.add(extension.resolve(relative));
        }
        for (Path bank : banks) {
            Path item = BankDirectories.item(staging.resolve("question-banks"), bank);
            if (Files.isDirectory(item, LinkOption.NOFOLLOW_LINKS)) leaves.add(item);
            declared.add(bank);
        }
        try (var paths = Files.walk(staging)) {
            for (Path path : paths.toList()) {
                Path relative = staging.relativize(path);
                if (relative.getNameCount() <= 2) continue; // Managed group names may begin with a dot.
                Path base = staging.resolve(relative.subpath(0, 2));
                Path leaf = staging.resolve(relative.subpath(0, 3));
                if (leaves.contains(leaf)) base = leaf;
                if (privatePath(base.relativize(path)) && !declared.contains(path))
                    throw invalid("题库包包含未声明的私有文件或目录");
            }
        }
    }
    private static Map<String, String> treeSignature(Path root) throws IOException {
        var values = new HashMap<String, String>();
        try (var stream = Files.walk(root)) {
            for (Path file : stream.filter(Files::isRegularFile).toList()) {
                LibraryManagement.checkPath(file); String name = LibraryManagement.relative(root, file);
                String value = name.endsWith(".json") ? Json.fingerprint(Json.read(file, (int) MAX_FILE), "archive-json") : ResourceStore.hash(Files.readAllBytes(file));
                values.put(name, value);
            }
        }
        return values;
    }
    private static boolean sameTree(Path first, Path second) throws IOException { return treeSignature(first).equals(treeSignature(second)); }
    private Path workspace() throws IOException {
        Path temporary = root.resolve(".temp"); if (!Files.exists(temporary, LinkOption.NOFOLLOW_LINKS)) Files.createDirectory(temporary);
        LibraryManagement.checkPath(temporary); return Files.createTempDirectory(temporary, "library-transfer-");
    }
    private static void removeWorkspace(Path workspace) throws IOException {
        // Only remove the freshly allocated workspace, never an installed bank or extension.
        if (!workspace.getFileName().toString().startsWith("library-transfer-") || !workspace.getParent().getFileName().toString().equals(".temp")) throw new IOException("Invalid archive workspace");
        LibraryManagement.checkPath(workspace);
        try (var stream = Files.walk(workspace)) { for (Path file : stream.sorted(Comparator.reverseOrder()).toList()) { if (Files.isSymbolicLink(file)) throw new IOException("Unsafe archive workspace"); Files.delete(file); } }
    }
    private static String archiveGroup(Path staging) throws IOException {
        Path marker = staging.resolve(MANIFEST);
        if (!Files.isRegularFile(marker)) throw invalid("不是 QuizForge 题库包：缺少格式标识");
        JsonNode manifest;
        try { manifest = Json.read(marker, 256 * 1024); } catch (IOException error) { throw invalid("题库包格式标识损坏"); }
        if (!manifest.isObject() || !FORMAT.equals(manifest.path("format").asText())) throw invalid("不是 QuizForge 题库包：格式标识不正确");
        if (!manifest.path("formatVersion").isIntegralNumber() || manifest.path("formatVersion").asLong() != 1) throw invalid("不支持此题库包版本，请升级应用");
        String group = null;
        for (String kind : List.of("question-banks", "extensions")) {
            Path directory = staging.resolve(kind);
            if (!Files.isDirectory(directory)) throw invalid("题库包顶层必须包含 question-banks 和 extensions 两个文件夹");
            List<Path> children; try (var stream = Files.list(directory)) { children = stream.toList(); }
            if (children.size() != 1 || !Files.isDirectory(children.get(0))) throw invalid("每个顶层文件夹必须只包含一个分组");
            Path child = children.get(0);
            if (Files.exists(child.resolve("bank.json")) || Files.exists(child.resolve("manifest.json")) || Files.exists(child.resolve("development.json"))) throw invalid("顶层目录必须是分组，不能是单个题库或拓展");
            String name = child.getFileName().toString(); LibraryManagement.folderName(name);
            if (group != null && !group.equals(name)) throw invalid("题库分组和拓展分组必须同名"); group = name;
        }
        if (!group.equals(manifest.path("group").asText())) throw invalid("格式标识中的分组与目录不一致");
        return group;
    }
    private static void unzip(Path zip, Path staging) throws IOException {
        long total = 0; int count = 0; var seen = new HashSet<String>();
        try (ZipFile archive = new ZipFile(zip.toFile())) {
            var entries = archive.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement(); String name = entry.getName();
                if (++count > MAX_ENTRIES) throw limit("压缩包文件数量超过上限");
                if (name.endsWith("/")) name = name.substring(0, name.length() - 1);
                String[] parts = name.split("/", -1);
                if (parts.length > 32 || parts.length == 0 || !(Set.of("question-banks", "extensions").contains(parts[0]) || (parts.length == 1 && name.equals(MANIFEST) && !entry.isDirectory()))) throw invalid("题库包顶层只允许格式标识、question-banks 和 extensions");
                for (String part : parts) {
                    if (part.isBlank() || part.equals(".") || part.equals("..") || part.endsWith(" ") || part.endsWith(".") || part.matches(".*[\\\\:*?\"<>|\\p{Cntrl}].*") || part.matches("(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\\..*)?")) throw invalid("压缩包包含无效或越界路径");
                }
                if (!seen.add(name.toLowerCase(Locale.ROOT))) throw invalid("压缩包包含重复路径");
                Path target = staging.resolve(name).normalize(); if (!target.startsWith(staging)) throw invalid("压缩包路径越界");
                if (entry.isDirectory()) Files.createDirectories(target);
                else {
                    if (entry.getSize() > MAX_FILE) throw limit("压缩包单个文件超过 8 MiB");
                    Files.createDirectories(target.getParent());
                    long bytes; try (InputStream input = archive.getInputStream(entry); OutputStream output = Files.newOutputStream(target, java.nio.file.StandardOpenOption.CREATE_NEW)) { bytes = transfer(input, output, Math.min(MAX_FILE, MAX_EXPANDED - total)); }
                    total += bytes;
                }
            }
        }
    }
    private static void zip(Path content, Path zip) throws IOException {
        long total = 0; int count = 0;
        try (ZipOutputStream output = new ZipOutputStream(Files.newOutputStream(zip)); var stream = Files.walk(content)) {
            for (Path path : stream.sorted().toList()) {
                if (path.equals(content)) continue;
                if (++count > MAX_ENTRIES) throw limit("导出文件数量超过上限");
                boolean directory = Files.isDirectory(path); long size = directory ? 0 : Files.size(path);
                if (size > MAX_FILE || (total += size) > MAX_EXPANDED) throw limit("导出内容超过大小上限");
                output.putNextEntry(new ZipEntry(LibraryManagement.relative(content, path) + (directory ? "/" : "")));
                if (!directory) Files.copy(path, output); output.closeEntry();
            }
        }
    }
    private static long transfer(InputStream input, OutputStream output, long limit) throws IOException {
        long count = 0; byte[] buffer = new byte[16384]; int size;
        while ((size = input.read(buffer)) != -1) { count += size; if (count > limit) throw limit("压缩包超过上传或解压大小上限"); output.write(buffer, 0, size); }
        return count;
    }
    private static ApiException invalid(String message) { return new ApiException(422, "INVALID_LIBRARY_ARCHIVE", message); }
    private static ApiException conflict(String message) { return new ApiException(409, "LIBRARY_IMPORT_CONFLICT", message); }
    private static ApiException limit(String message) { return new ApiException(413, "LIBRARY_ARCHIVE_LIMIT", message); }
}

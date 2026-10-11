package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;

/** Metadata only. A pending row is never a validated, writable Collection. */
final class LibraryIndex {
    record Candidate(String kind, String id, Path source, ObjectNode metadata) {
        Candidate { metadata = metadata.deepCopy(); }
        @Override public ObjectNode metadata() { return metadata.deepCopy(); }
    }
    record Snapshot(String revision, List<Candidate> candidates, ObjectNode catalog) {
        Snapshot { candidates = List.copyOf(candidates); catalog = catalog.deepCopy(); }
        @Override public ObjectNode catalog() { return catalog.deepCopy(); }
    }
    private final Path root;
    private final DevelopmentSettings settings;
    LibraryIndex(Path root, DevelopmentSettings settings) { this.root = root.toAbsolutePath().normalize(); this.settings = settings; }

    Snapshot scan() {
        var candidates = new ArrayList<Candidate>(); var available = new HashSet<String>();
        ArrayNode packages = Json.MAPPER.createArrayNode(), banks = Json.MAPPER.createArrayNode(), identities = Json.MAPPER.createArrayNode();
        List<Path> folders = ExtensionDirectories.scan(root.resolve("extensions"));
        var names = new HashMap<String,Integer>();
        for (Path dir : folders) if (DevelopmentExtensions.marked(dir)) names.merge(dir.getFileName().toString(), 1, Integer::sum);
        for (Path dir : folders) {
            boolean development = DevelopmentExtensions.marked(dir); if (development && !settings.enabled()) continue;
            String folder = dir.getFileName().toString(), kind = development ? "development" : "extension";
            ObjectNode row = Json.object().put("id", folder).put("kind", kind).put("version", "?").put("name", folder).put("description", "").put("questionCount", 0).put("validationStatus", "pending");
            row.put("path", LibraryManagement.relative(root.resolve("extensions"), dir));
            String group = ExtensionDirectories.group(root.resolve("extensions"), dir); if (!group.isEmpty()) row.put("group", group);
            try {
                JsonNode declaration = Files.exists(dir.resolve("manifest.json"), LinkOption.NOFOLLOW_LINKS) ? Json.read(Json.safeFile(dir, "manifest.json"), 256 * 1024) : Json.object();
                JsonNode marker = development ? Json.read(Json.safeFile(dir, "development.json"), 256 * 1024) : Json.object();
                if (!declaration.isObject() || !marker.isObject()) throw ApiException.bad("Invalid extension declaration");
                if (development) {
                    Json.id(Json.object().put("folder", folder), "folder");
                    if (names.get(folder) != 1) throw ApiException.bad("Development leaf folder names must be globally unique");
                    if (marker.has("mode") && (!marker.path("mode").isTextual() || !List.of("ui", "runtime").contains(marker.path("mode").asText()))) throw ApiException.bad("Invalid legacy development mode");
                    if (marker.has("types") || marker.has("packageFormatVersion")) throw ApiException.bad("Each extension provides one question type");
                    row.put("name", marker.has("name") ? Json.text(marker, "name", 300) : declaration.has("name") ? Json.text(declaration, "name", 300) : folder);
                    row.put("title", row.path("name").asText()).put("description", Library.optional(marker, "description", 4000));
                    row.set("development", Json.object().put("folder", folder));
                    row.put("version", declaration.has("version") ? Json.id(declaration, "version") : "0.0.0");
                    available.add("development:" + folder);
                } else {
                    ExtensionApi.requireManifest(declaration);
                    if (declaration.has("types") || declaration.has("packageFormatVersion")) throw ApiException.bad("Each extension provides one question type");
                    row.put("id", Json.id(declaration, "id")).put("version", Json.id(declaration, "version")).put("name", Json.text(declaration, "name", 300)).put("description", Library.optional(declaration, "description", 4000));
                    available.add(row.path("id").asText() + "@" + row.path("version").asText());
                }
                JsonNode exampleName = declaration.has("examples") ? declaration.path("examples") : marker.path("examples");
                if (exampleName.isTextual()) {
                    String relative = exampleName.asText(); Path name = Path.of(relative);
                    if (relative.isBlank() || relative.length() > 240 || name.isAbsolute() || relative.contains("\\") || relative.contains(":") || !dir.resolve(name).normalize().startsWith(dir)) throw ApiException.bad("Invalid examples path");
                    Path example = dir.resolve(name);
                    if (Files.exists(example, LinkOption.NOFOLLOW_LINKS)) {
                        JsonNode raw = Json.read(Json.safeFile(dir, exampleName.asText()), 8 * 1024 * 1024);
                        row.put("questionCount", raw.path("questions").isArray() ? raw.path("questions").size() : 0);
                        identities.add(Json.fingerprint(raw, "index-examples"));
                    }
                }
                identities.add(Json.fingerprint(declaration, "index-manifest")); identities.add(Json.fingerprint(marker, "index-development"));
            } catch (Exception failure) { error(row, failure, "INVALID_EXTENSION"); }
            candidates.add(new Candidate(kind, row.path("id").asText(), dir, row)); packages.add(row);
        }
        for (Path file : BankDirectories.scan(root.resolve("question-banks")).banks()) {
            Path item = BankDirectories.item(root.resolve("question-banks"), file);
            ObjectNode row = Json.object().put("id", file.getFileName().toString().replaceFirst("\\.json$", "")).put("kind", "bank").put("title", item.getFileName().toString()).put("description", "").put("questionCount", 0).put("validationStatus", "pending");
            row.put("path", LibraryManagement.relative(root.resolve("question-banks"), item));
            String group = LibraryManagement.relative(root.resolve("question-banks"), item.getParent()); if (!group.isEmpty()) row.put("group", group);
            try {
                JsonNode raw = Json.read(file, 8 * 1024 * 1024);
                boolean development = Library.hasDevelopmentReference(raw); if (development && !settings.enabled()) continue;
                ExtensionApi.requireBank(raw); row.set("features", BankFeatures.read(raw).json());
                row.put("id", Json.id(raw, "id")).put("title", Json.text(raw, "title", 300)).put("description", Library.optional(raw, "description", 4000));
                JsonNode questions = raw.path("questions"); if (!questions.isArray() || questions.isEmpty() || questions.size() > 10000) throw ApiException.bad("Invalid questions");
                var ids = new HashSet<String>(); var references = new LinkedHashMap<String,JsonNode>();
                for (JsonNode question : questions) {
                    if (!ids.add(Json.id(question, "id")) || !question.has("data")) throw ApiException.bad("Duplicate question or missing data");
                    Json.text(question, "title", 300); if (question.has("features")) throw ApiException.bad("features belong at the bank root");
                    JsonNode reference = question.has("extension") ? question.path("extension") : raw.path("extension");
                    String key = referenceKey(reference); if (!available.contains(key)) throw ApiException.bad("Missing extension"); references.putIfAbsent(key, reference);
                }
                row.put("questionCount", questions.size()); row.set("extension", raw.has("extension") ? raw.path("extension").deepCopy() : Json.MAPPER.nullNode());
                ArrayNode bindings = row.putArray("extensions"); references.values().forEach(value -> bindings.add(value.deepCopy()));
                if (development) { row.put("kind", "development-bank"); row.set("development", Library.bankDevelopmentMetadata(Library.developmentFolders(raw))); }
                identities.add(Json.fingerprint(raw, "index-bank"));
            } catch (Exception failure) { error(row, failure, "INVALID_BANK"); }
            candidates.add(new Candidate(row.path("kind").asText(), row.path("id").asText(), file, row)); banks.add(row);
        }
        ObjectNode result = Json.object(); result.set("banks", banks); result.set("extensions", latest(packages));
        result.put("developmentEnabled", settings.enabled()); result = new LibraryManagement(root).catalog(result);
        identities.add(result); String revision = Json.fingerprint(identities, "quizforge-library-index-v1"); result.put("indexRevision", revision);
        return new Snapshot(revision, candidates, result);
    }
    static String referenceKey(JsonNode reference) {
        if (!reference.isObject() || reference.has("typeId")) throw ApiException.bad("Invalid extension reference");
        if (reference.has("development")) { if (reference.size() != 1) throw ApiException.bad("Invalid development reference"); return "development:" + Json.id(reference, "development"); }
        return Json.id(reference, "id") + "@" + Json.id(reference, "version");
    }
    static ArrayNode latest(ArrayNode rows) {
        var versions = new HashMap<String,String>();
        for (JsonNode row : rows) if (row.path("kind").asText().equals("extension") && !row.has("error")) versions.merge(row.path("id").asText(), row.path("version").asText(), (a,b) -> Library.compareVersion(a,b) >= 0 ? a : b);
        ArrayNode result = Json.MAPPER.createArrayNode();
        for (JsonNode row : rows) if (!row.path("kind").asText().equals("extension") || row.has("error") || row.path("version").asText().equals(versions.get(row.path("id").asText()))) result.add(row);
        return result;
    }
    static void error(ObjectNode row, Exception failure, String code) {
        row.put("validationStatus", "error").put("error", failure.getMessage() == null ? "Invalid library entry" : failure.getMessage());
        row.put("errorCode", failure instanceof ApiException api ? api.code : code).put("errorStatus", failure instanceof ApiException api ? api.status : 422);
    }
}

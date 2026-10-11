package io.quizforge.web;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class LibraryArchiveTest {
    @TempDir Path root;
    byte[] zip(Map<String,String> files) throws Exception {
        var bytes = new ByteArrayOutputStream();
        try (var output = new ZipOutputStream(bytes)) {
            for (var entry : files.entrySet()) {
                output.putNextEntry(new ZipEntry(entry.getKey())); output.write(entry.getValue().getBytes(java.nio.charset.StandardCharsets.UTF_8)); output.closeEntry();
            }
        }
        return bytes.toByteArray();
    }
    byte[] zipBytes(Map<String,byte[]> files) throws Exception {
        var bytes = new ByteArrayOutputStream();
        try (var output = new ZipOutputStream(bytes)) {
            for (var entry : files.entrySet()) { output.putNextEntry(new ZipEntry(entry.getKey())); output.write(entry.getValue()); output.closeEntry(); }
        }
        return bytes.toByteArray();
    }
    Map<String,String> emptyPackage() {
        var files = new LinkedHashMap<String,String>();
        files.put(LibraryArchive.MANIFEST, "{\"format\":\"quizforge-bank-group\",\"formatVersion\":1,\"group\":\"练习\"}");
        files.put("question-banks/练习/", ""); files.put("extensions/练习/", ""); return files;
    }
    void rejected(Map<String,String> files) throws Exception {
        byte[] bytes = zip(files);
        assertThrows(ApiException.class, () -> new LibraryArchive(root,new ResourceStore(root)).importPackage(new ByteArrayInputStream(bytes), stage -> fail("must reject before running code")));
        assertFalse(Files.exists(root.resolve("question-banks"))); assertFalse(Files.exists(root.resolve("extensions")));
        try (var paths = Files.list(root.resolve(".temp"))) { assertEquals(0, paths.count()); }
    }
    @Test void ordinaryZipRenamedQbankUnsupportedVersionsAndPathTraversalAreRejected() throws Exception {
        var files = emptyPackage(); files.remove(LibraryArchive.MANIFEST); rejected(files);
        files = emptyPackage(); files.put(LibraryArchive.MANIFEST,"{\"format\":\"other\",\"formatVersion\":1,\"group\":\"练习\"}"); rejected(files);
        files = emptyPackage(); files.put(LibraryArchive.MANIFEST,"{\"format\":\"quizforge-bank-group\",\"formatVersion\":2,\"group\":\"练习\"}"); rejected(files);
        files = emptyPackage(); files.put("question-banks/../outside.txt","escape"); rejected(files);
        files = emptyPackage(); files.put("question-banks/练习/A.json","{}"); files.put("question-banks/练习/a.json","{}"); rejected(files);
        files = emptyPackage(); files.put("question-banks/练习/bank.json","{}"); rejected(files);
        files = emptyPackage(); files.put("settings.json","{}"); rejected(files);
    }
    @Test void emptyGroupsRoundTripAndResourceReferencesMustExist() throws Exception {
        var files = emptyPackage();
        var result = new LibraryArchive(root,new ResourceStore(root)).importPackage(new ByteArrayInputStream(zip(files)), stage -> {});
        assertEquals(0,result.path("importedBanks").asInt()); assertTrue(Files.isDirectory(root.resolve("question-banks/练习")));
        try (var download = new LibraryArchive(root,new ResourceStore(root)).exportGroup("练习")) {
            assertTrue(download.file().toString().endsWith(".qbank"));
            assertEquals(0,new LibraryArchive(root,new ResourceStore(root)).importPackage(Files.newInputStream(download.file()),stage -> {}).path("importedBanks").asInt());
        }
        files.put("question-banks/练习/new/bank.json","{\"id\":\"new\",\"questions\":[],\"image\":{\"type\":\"image\",\"attrs\":{\"assetId\":\"" + "a".repeat(64) + "\"}}}");
        final byte[] missing = zip(files);
        assertThrows(ApiException.class,()->new LibraryArchive(root,new ResourceStore(root)).importPackage(new ByteArrayInputStream(missing),stage -> {}));
        assertFalse(Files.exists(root.resolve("question-banks/练习/new")));
    }
    @Test void managedDotPrefixedGroupRoundTripsWithoutChangingItsName() throws Exception {
        Files.createDirectory(root.resolve("question-banks")); Files.createDirectory(root.resolve("extensions"));
        new LibraryManagement(root).change(Json.object().put("kind", "bank").put("target", "group")
                .put("action", "create").put("name", ".练习"), Json.object());
        Path imported = root.resolve("imported"); Files.createDirectory(imported);
        try (var download = new LibraryArchive(root, new ResourceStore(root)).exportGroup(".练习")) {
            var result = new LibraryArchive(imported, new ResourceStore(imported)).importPackage(Files.newInputStream(download.file()), stage -> {});
            assertEquals(".练习", result.path("group").asText());
            assertTrue(Files.isDirectory(imported.resolve("question-banks/.练习")));
            assertTrue(Files.isDirectory(imported.resolve("extensions/.练习")));
        }
    }
    @Test void malformedExtensionDeclarationsAreRejectedBeforeRulesWithArchiveErrors() throws Exception {
        for (String manifest : java.util.List.of("", "[]", "{broken", "{\"id\":\"type\",\"version\":\"1.0.0\"}")) {
            Map<String, String> files = emptyPackage(); files.put("extensions/练习/type/manifest.json", manifest);
            ApiException rejected = assertThrows(ApiException.class, () -> new LibraryArchive(root, new ResourceStore(root))
                    .importPackage(new ByteArrayInputStream(zip(files)), stage -> fail("invalid declarations must be rejected before running rules")));
            assertEquals(422, rejected.status); assertEquals("INVALID_LIBRARY_ARCHIVE", rejected.code);
            assertFalse(Files.exists(root.resolve("extensions"))); assertFalse(Files.exists(root.resolve("question-banks")));
        }
    }
    @Test void declaredHiddenExtensionFilesRoundTripAndUnrelatedPrivateFilesAreExcluded() throws Exception {
        ServerTest fixture = new ServerTest(); fixture.root = root; fixture.prepare();
        Files.createDirectory(root.resolve("question-banks/.练习"));
        Files.move(root.resolve("question-banks/bank.json"), root.resolve("question-banks/.练习/questions.json"));
        Path extension = root.resolve("extensions/generic");
        var manifest = (com.fasterxml.jackson.databind.node.ObjectNode) Json.read(extension.resolve("manifest.json"), 256 * 1024);
        Files.move(extension.resolve("page.html"), extension.resolve(".page.html")); manifest.put("entry", ".page.html");
        Files.createDirectory(extension.resolve(".scripts"));
        Files.move(extension.resolve("page.js"), extension.resolve(".scripts/page.js")); manifest.put("script", ".scripts/page.js");
        Files.createDirectory(extension.resolve("assets"));
        byte[] image = java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6VQAAAAASUVORK5CYII=");
        Files.write(extension.resolve("assets/.illustration.png"), image); manifest.putArray("assets").add("assets/.illustration.png");
        Files.writeString(extension.resolve("manifest.json"), manifest.toString());
        Files.writeString(extension.resolve(".env"), "synthetic private configuration");
        Files.writeString(extension.resolve(".scripts/unrelated.txt"), "synthetic private source");
        Files.createDirectory(extension.resolve(".editor"));
        for (String file : java.util.List.of("page.html", "page.js", "page.css")) Files.writeString(extension.resolve(".editor/" + file), "editor " + file);
        Files.writeString(extension.resolve("editor.json"), "{\"entry\":\".editor/page.html\",\"script\":\".editor/page.js\",\"style\":\".editor/page.css\"}");
        Path imported = root.resolve("imported"); Files.createDirectory(imported);
        try (var download = new LibraryArchive(root, new ResourceStore(root)).exportGroup(".练习")) {
            Map<String, byte[]> entries = archiveEntries(download.file());
            String prefix = "extensions/.练习/generic@1.0.0/";
            assertTrue(entries.containsKey(prefix + ".page.html")); assertTrue(entries.containsKey(prefix + ".scripts/page.js"));
            assertArrayEquals(image, entries.get(prefix + "assets/.illustration.png"));
            assertTrue(entries.containsKey(prefix + ".editor/page.html"));
            assertFalse(entries.containsKey(prefix + ".env")); assertFalse(entries.containsKey(prefix + ".scripts/unrelated.txt"));
            new LibraryArchive(imported, new ResourceStore(imported)).importPackage(Files.newInputStream(download.file()), stage -> {});
            assertEquals(Files.readString(extension.resolve(".page.html")), Files.readString(imported.resolve(prefix + ".page.html")));
            assertArrayEquals(image, Files.readAllBytes(imported.resolve(prefix + "assets/.illustration.png")));
            assertFalse(Files.exists(imported.resolve(prefix + ".env")));
            entries.put(prefix + ".env", "synthetic private configuration".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            ApiException rejected = assertThrows(ApiException.class, () -> new LibraryArchive(imported, new ResourceStore(imported))
                    .importPackage(new ByteArrayInputStream(zipBytes(entries)), stage -> fail("private paths must be rejected before running rules")));
            assertEquals("INVALID_LIBRARY_ARCHIVE", rejected.code);
        }
    }
    private Map<String, byte[]> archiveEntries(Path file) throws Exception {
        var entries = new LinkedHashMap<String, byte[]>();
        try (var input = new ZipInputStream(Files.newInputStream(file))) {
            for (ZipEntry entry; (entry = input.getNextEntry()) != null;) entries.put(entry.getName(), input.readAllBytes());
        }
        return entries;
    }
    HttpResponse<byte[]> send(ServerTest fixture,String path,String type,byte[] body,String origin) throws Exception {
        var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+fixture.server.port()+path)).timeout(Duration.ofSeconds(90)).header("Content-Type",type).header("Origin",origin).POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();
        return fixture.client.send(request,HttpResponse.BodyHandlers.ofByteArray());
    }
    @Test void httpExportImportSkipsIdenticalContentPreservesHistoryAndRejectsConflicts() throws Exception {
        ServerTest fixture = new ServerTest(); fixture.root=root; fixture.prepare();
        Files.createDirectory(root.resolve("question-banks/练习")); Files.move(root.resolve("question-banks/bank.json"),root.resolve("question-banks/练习/questions.json"));
        // A mixed bank uses extensions in different physical locations.
        Path second = root.resolve("extensions/另一组/generic2"); Files.createDirectories(second);
        try (var paths = Files.list(root.resolve("extensions/generic"))) {
            for (Path path : paths.toList()) Files.writeString(second.resolve(path.getFileName()), Files.readString(path).replace("\"generic\"", "\"generic2\""));
        }
        var bank = (com.fasterxml.jackson.databind.node.ObjectNode) Json.read(root.resolve("question-banks/练习/questions.json"), 1024 * 1024);
        ((com.fasterxml.jackson.databind.node.ObjectNode) bank.path("questions").get(1)).set("extension", Json.object().put("id", "generic2").put("version", "1.0.0"));
        String png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xQAAAAASUVORK5CYII=";
        var image = new ResourceStore(root).upload(Json.object().put("mime", "image/png").put("data", png));
        var richImage = Json.object().put("type", "image"); richImage.set("attrs", Json.object().put("assetId", image.path("id").asText()));
        // Host bank metadata can contain rich content; exercise cache-backed export.
        bank.set("illustration", richImage); Files.writeString(root.resolve("question-banks/练习/questions.json"), bank.toString());
        fixture.start(null);
        try {
            String origin="http://127.0.0.1:"+fixture.server.port();
            assertEquals(200,fixture.post(ServerTest.QUESTION+"/actions",fixture.action("archive-submit-1",0,"submit",fixture.answer("yes"))).status());
            String history=fixture.get("/api/collections/bank/bank/history").body().toString();
            var exported=send(fixture,"/api/library/export","application/json","{\"group\":\"练习\"}".getBytes(),origin);
            assertEquals(200,exported.statusCode(),new String(exported.body())); assertEquals(LibraryArchive.MIME,exported.headers().firstValue("Content-Type").orElseThrow());
            assertTrue(exported.headers().firstValue("Content-Disposition").orElseThrow().contains(".qbank"));
            var entries=new LinkedHashMap<String,byte[]>();
            try (var input=new ZipInputStream(new ByteArrayInputStream(exported.body()))) {
                ZipEntry entry; while ((entry=input.getNextEntry())!=null) entries.put(entry.getName(),input.readAllBytes());
            }
            assertTrue(entries.containsKey("extensions/练习/generic@1.0.0/manifest.json")); assertTrue(entries.containsKey("question-banks/练习/bank/bank.json"));
            assertTrue(entries.containsKey("extensions/练习/generic2@1.0.0/manifest.json"));
            assertTrue(entries.containsKey("question-banks/练习/bank/assets/" + image.path("id").asText() + ".png"));
            assertFalse(entries.keySet().stream().anyMatch(name->name.contains(".state")||name.contains(".history")));
            var duplicate=send(fixture,"/api/library/import",LibraryArchive.MIME,exported.body(),origin);
            assertEquals(200,duplicate.statusCode(),new String(duplicate.body())); var skipped=Json.MAPPER.readTree(duplicate.body());
            assertEquals(1,skipped.path("skippedBanks").asInt()); assertEquals(2,skipped.path("skippedExtensions").asInt());
            assertEquals(history,fixture.get("/api/collections/bank/bank/history").body().toString()); assertEquals("submitted",fixture.get(ServerTest.QUESTION).body().at("/state/status").asText());
            String original=Files.readString(root.resolve("question-banks/练习/questions.json"));
            entries.put("question-banks/练习/bank/bank.json",new String(entries.get("question-banks/练习/bank/bank.json"),java.nio.charset.StandardCharsets.UTF_8).replace("Test bank","Changed bank").getBytes(java.nio.charset.StandardCharsets.UTF_8));
            var conflict=send(fixture,"/api/library/import",LibraryArchive.MIME,zipBytes(entries),origin);
            assertEquals(409,conflict.statusCode(),new String(conflict.body())); assertEquals(original,Files.readString(root.resolve("question-banks/练习/questions.json")));
            assertEquals(403,send(fixture,"/api/library/import",LibraryArchive.MIME,exported.body(),"http://evil.example").statusCode());
            assertEquals(415,send(fixture,"/api/library/import","application/zip",exported.body(),origin).statusCode());
            assertEquals(404,send(fixture,"/api/library/export","application/json","{\"group\":\"questions.json\"}".getBytes(),origin).statusCode());
            var originalBank = entries.get("question-banks/练习/bank/bank.json");
            entries.put("question-banks/练习/bank/bank.json", originalBank = new String(originalBank,java.nio.charset.StandardCharsets.UTF_8).replace("Changed bank","Test bank").getBytes(java.nio.charset.StandardCharsets.UTF_8));
            String page = "extensions/练习/generic@1.0.0/page.js"; byte[] originalPage=entries.get(page);
            entries.put(page, (new String(originalPage)+"\n// altered code").getBytes());
            assertEquals(409,send(fixture,"/api/library/import",LibraryArchive.MIME,zipBytes(entries),origin).statusCode());
            entries.put(page,originalPage); entries.remove("extensions/练习/generic2@1.0.0/manifest.json");
            assertEquals(422,send(fixture,"/api/library/import",LibraryArchive.MIME,zipBytes(entries),origin).statusCode());
            Files.delete(root.resolve("question-banks/练习/questions.json"));
            Files.move(root.resolve("extensions/generic"),root.resolve(".temp/old-generic"));
            Files.move(root.resolve("extensions/另一组/generic2"),root.resolve(".temp/old-generic2"));
            var imported=send(fixture,"/api/library/import",LibraryArchive.MIME,exported.body(),origin);
            assertEquals(200,imported.statusCode(),new String(imported.body())); assertEquals(1,Json.MAPPER.readTree(imported.body()).path("importedBanks").asInt()); assertEquals(2,Json.MAPPER.readTree(imported.body()).path("importedExtensions").asInt());
            assertTrue(Files.exists(root.resolve("question-banks/练习/bank/bank.json"))); assertEquals("submitted",fixture.get(ServerTest.QUESTION).body().at("/state/status").asText());
        } finally { fixture.close(); }
    }
}

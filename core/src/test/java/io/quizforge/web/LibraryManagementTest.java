package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class LibraryManagementTest {
    @TempDir Path root;
    final ServerTest fixture = new ServerTest();
    @BeforeEach void prepare() throws Exception { fixture.root = root; fixture.prepare(); fixture.start(null); }
    @AfterEach void close() { fixture.close(); }
    ServerTest.Reply manage(String kind, String target, String action, String path, String name, String group) throws Exception {
        ObjectNode body = Json.object().put("kind", kind).put("target", target).put("action", action).put("path", path);
        if (name != null) body.put("name", name); if (group != null) body.put("group", group);
        return fixture.post("/api/library/manage", body);
    }
    JsonNode catalog() throws Exception { var reply = fixture.get("/api/catalog"); assertEquals(200, reply.status(), reply.body().toString()); return reply.body(); }
    void enable() throws Exception { assertEquals(200, fixture.call("PUT", "/api/settings/development", "{\"enabled\":true}", null, "http://127.0.0.1:" + fixture.server.port()).status()); }

    @Test void groupedBanksRenameAndMoveWithoutLosingAnswersOrFrozenHistory() throws Exception {
        assertEquals(200, fixture.post(ServerTest.QUESTION + "/actions", fixture.action("group-submit-first", 0, "submit", fixture.answer("yes"))).status());
        assertEquals(200, manage("bank", "group", "create", "", "练习", "").status());
        assertEquals(200, manage("bank", "item", "update", "bank.json", "新名称", "练习").status());
        assertTrue(Files.exists(root.resolve("question-banks/练习/bank.questions.json")));
        assertEquals("练习", catalog().at("/banks/0/group").asText()); assertEquals("新名称", catalog().at("/banks/0/title").asText());
        assertEquals("submitted", fixture.get(ServerTest.QUESTION).body().at("/state/status").asText());
        String history = fixture.get("/api/collections/bank/bank/history").body().at("/records/0/id").asText();
        assertEquals("Test bank", fixture.get("/api/collections/bank/bank/history/" + history).body().path("collectionTitle").asText());
        assertEquals(200, manage("bank", "group", "update", "练习", "学习", "").status()); assertEquals("学习", catalog().at("/banks/0/group").asText());
        assertEquals(200, manage("bank", "item", "update", "学习/bank.questions.json", "再次修改", "").status());
        assertEquals("submitted", fixture.get(ServerTest.QUESTION).body().at("/state/status").asText());
    }
    @Test void packagedBankKeepsAssetsAndDoesNotTreatItsOwnFolderAsAGroup() throws Exception {
        Files.createDirectories(root.resolve("question-banks/学科/资料/assets"));
        Files.move(root.resolve("question-banks/bank.json"), root.resolve("question-banks/学科/资料/bank.json"));
        Files.writeString(root.resolve("question-banks/学科/资料/assets/note.txt"), "Keep this file");
        JsonNode before = catalog(); assertEquals("学科", before.at("/banks/0/group").asText()); assertEquals("学科/资料", before.at("/banks/0/path").asText()); assertEquals(1, before.at("/groups/banks").size());
        assertEquals(200, manage("bank", "item", "update", "学科/资料", "移动资料", "").status());
        assertEquals("Keep this file", Files.readString(root.resolve("question-banks/资料/assets/note.txt"))); assertFalse(catalog().at("/banks/0").has("group"));
    }
    @Test void archiveGroupKeepsAllFilesAndHistoryAndCatalogUpdatesOnEmptyFolders() throws Exception {
        fixture.post(ServerTest.QUESTION + "/actions", fixture.action("archive-submit-first", 0, "submit", fixture.answer("yes")));
        manage("bank", "group", "create", "", "归档", ""); manage("bank", "item", "update", "bank.json", "归档练习", "归档");
        Files.writeString(root.resolve("question-banks/归档/note.md"), "Preserved");
        var removed = manage("bank", "group", "delete", "归档", null, null); assertEquals(200, removed.status(), removed.body().toString());
        Path trash = root.resolve(removed.body().path("archivedTo").asText()); assertTrue(Files.exists(trash.resolve("content/归档/bank.questions.json"))); assertEquals("Preserved", Files.readString(trash.resolve("content/归档/note.md")));
        assertEquals(0, catalog().path("banks").size()); assertEquals(0, catalog().at("/groups/banks").size());
        assertEquals(1, fixture.get("/api/collections/bank/bank/history").body().path("records").size());
        Files.move(trash.resolve("content/归档"), root.resolve("question-banks/归档"));
        assertEquals("submitted", fixture.get(ServerTest.QUESTION).body().at("/state/status").asText());
        Files.createDirectory(root.resolve("question-banks/外部空分组")); assertEquals(2, catalog().at("/groups/banks").size());
    }
    @Test void extensionDisplayNameDoesNotChangeFormalFilesAndReferencesPreventDeletion() throws Exception {
        byte[] manifest = Files.readAllBytes(root.resolve("extensions/generic/manifest.json"));
        assertEquals(404, manage("extension", "group", "create", "", "类型", "").status()); enable();
        assertEquals(200, manage("extension", "group", "create", "", "类型", "").status());
        assertEquals(200, manage("extension", "item", "update", "generic", "题型新名称", "类型").status());
        assertArrayEquals(manifest, Files.readAllBytes(root.resolve("extensions/类型/generic/manifest.json"))); assertEquals("题型新名称", catalog().at("/extensions/0/name").asText());
        assertEquals(200, fixture.get(ServerTest.QUESTION).status()); assertEquals(409, manage("extension", "item", "delete", "类型/generic", null, null).status());
        assertEquals(409, manage("extension", "group", "delete", "类型", null, null).status());
        manage("bank", "item", "delete", "bank.json", null, null); assertEquals(200, manage("extension", "group", "delete", "类型", null, null).status());
        assertEquals(0, catalog().path("extensions").size());
    }
    @Test void traversalConflictsReservedNamesAndSelfMovesAreRejectedWithoutTouchingSources() throws Exception {
        manage("bank", "group", "create", "", "A", ""); assertEquals(400, manage("bank", "group", "create", "", "B", "A").status());
        assertEquals(400, manage("bank", "group", "update", "A", "Moved", "A").status());
        assertEquals(400, manage("bank", "group", "create", "", "../outside", "").status());
        assertEquals(400, manage("bank", "group", "create", "", "CON", "").status());
        assertEquals(400, manage("bank", "item", "delete", "../extensions/generic", null, null).status());
        Files.copy(root.resolve("question-banks/bank.json"), root.resolve("question-banks/A/bank.questions.json"));
        assertEquals(409, manage("bank", "item", "update", "bank.json", "Collision", "A").status());
        assertEquals("Test bank", Json.read(root.resolve("question-banks/bank.json"), 8 * 1024 * 1024).path("title").asText());
        assertEquals(403, fixture.call("POST", "/api/library/manage", "{}", null, "http://evil.example").status());
    }
    @Test void bankAndExtensionGroupsCannotBeNestedButCanBeRenamed() throws Exception {
        enable();
        for (String kind : java.util.List.of("bank", "extension")) {
            assertEquals(200, manage(kind, "group", "create", "", "A", "").status());
            assertEquals(200, manage(kind, "group", "create", "", "B", "").status());
            assertEquals(400, manage(kind, "group", "create", "", "Child", "A").status());
            assertEquals(400, manage(kind, "group", "update", "B", "Moved", "A").status());
            String folder = kind.equals("bank") ? "question-banks" : "extensions";
            assertTrue(Files.isDirectory(root.resolve(folder + "/B")));
            assertFalse(Files.exists(root.resolve(folder + "/A/Child")));
            assertEquals(200, manage(kind, "group", "update", "B", "Renamed", "").status());
            assertTrue(Files.isDirectory(root.resolve(folder + "/Renamed")));
        }
    }
    @Test void bankScannerRejectsNestedGroupsWithoutChangingFiles() throws Exception {
        Path nested = root.resolve("nested-banks/A/B"); Files.createDirectories(nested);
        assertThrows(ApiException.class, () -> BankDirectories.scan(root.resolve("nested-banks")));
        Files.createDirectory(nested.resolve("book")); Files.copy(root.resolve("question-banks/bank.json"), nested.resolve("book/bank.json"));
        assertThrows(ApiException.class, () -> BankDirectories.scan(root.resolve("nested-banks")));
        assertTrue(Files.exists(nested.resolve("book/bank.json")));
    }
    @Test void deletionReusesUnchangedContentButRechecksChangedDataRulesAndSchemas() throws Exception {
        String original = Files.readString(root.resolve("question-banks/bank.json"));
        for (int i = 0; i < 4; i++) fixture.write("question-banks/remove" + i + ".json", original.replace("\"id\":\"bank\"", "\"id\":\"remove" + i + "\""));
        String revision = catalog().at("/banks/0/contentRevision").asText(); assertFalse(revision.isEmpty());
        assertEquals(200, manage("bank", "item", "delete", "remove0.json", null, null).status());
        assertEquals(revision, catalog().at("/banks/0/contentRevision").asText());

        fixture.write("question-banks/bank.json", original.replace("\"public\":\"visible\"", "\"public\":\"\""));
        JsonNode changedData = manage("bank", "item", "delete", "remove1.json", null, null).body();
        assertTrue(changedData.at("/catalog/banks/0").has("error"), changedData.toString());
        fixture.write("question-banks/bank.json", original);
        assertFalse(catalog().at("/banks/0").has("error"));

        String rules = Files.readString(root.resolve("extensions/generic/rules.js"));
        fixture.write("extensions/generic/rules.js", rules.replace("data.public.length > 0", "data.public === 'other'"));
        assertTrue(manage("bank", "item", "delete", "remove2.json", null, null).body().at("/catalog/banks/0").has("error"));
        fixture.write("extensions/generic/rules.js", rules); assertFalse(catalog().at("/banks/0").has("error"));

        ObjectNode schema = (ObjectNode) Json.read(root.resolve("extensions/generic/question.json"), 1024 * 1024);
        ((ObjectNode) schema.at("/properties/public")).put("const", "other");
        fixture.write("extensions/generic/question.json", schema.toString());
        assertTrue(manage("bank", "item", "delete", "remove3.json", null, null).body().at("/catalog/banks/0").has("error"));
    }
    @Test void deletingDuplicateBankRevalidatesAndExposesTheRemainingCopy() throws Exception {
        fixture.write("question-banks/z-copy.json", Files.readString(root.resolve("question-banks/bank.json")).replace("Test bank", "Remaining bank"));
        assertTrue(catalog().at("/banks/1").has("error"));
        JsonNode changed = manage("bank", "item", "delete", "bank.json", null, null).body().path("catalog");
        assertEquals(1, changed.path("banks").size()); assertFalse(changed.at("/banks/0").has("error"));
        assertEquals("Remaining bank", changed.at("/banks/0/title").asText()); assertEquals(200, fixture.get(ServerTest.QUESTION).status());
    }
    @Test void reloadedCatalogRetainsChildOutlinesAndDetectsChangedOutlineRules() throws Exception {
        ObjectNode manifest = (ObjectNode) Json.read(root.resolve("extensions/generic/manifest.json"), 1024 * 1024);
        manifest.putObject("requiresApi").put("major", 1).put("minMinor", 1).putArray("capabilities").add("outline-items");
        fixture.write("extensions/generic/manifest.json", manifest.toString());
        String rules = Files.readString(root.resolve("extensions/generic/rules.js"));
        String withOutline = rules.replace("QF.defineType({", "QF.defineType({getOutlineItems(){return [{id:'part',label:'(1)'}];},");
        fixture.write("extensions/generic/rules.js", withOutline);
        String bank = Files.readString(root.resolve("question-banks/bank.json"));
        for (int i = 0; i < 2; i++) fixture.write("question-banks/remove" + i + ".json", bank.replace("\"id\":\"bank\"", "\"id\":\"remove" + i + "\""));
        String revision = catalog().at("/banks/0/contentRevision").asText();
        assertEquals(200, manage("bank", "item", "delete", "remove0.json", null, null).status());
        assertEquals("(1)", fixture.get("/api/collections/bank/bank").body().at("/questions/0/outlineItems/0/label").asText());
        fixture.write("extensions/generic/rules.js", withOutline.replace("(1)", "(2)"));
        assertEquals(200, manage("bank", "item", "delete", "remove1.json", null, null).status());
        assertNotEquals(revision, catalog().at("/banks/0/contentRevision").asText());
        assertEquals("(2)", fixture.get("/api/collections/bank/bank").body().at("/questions/0/outlineItems/0/label").asText());
    }
    @Test void changedRuleRunnerIsNotReusedWhenDeletionReloadsTheCatalog() throws Exception {
        fixture.write("question-banks/remove.json", Files.readString(root.resolve("question-banks/bank.json")).replace("\"id\":\"bank\"", "\"id\":\"remove\""));
        catalog(); fixture.write("server/rules-runner.cjs", "process.stdout.write(JSON.stringify({ok:false}));");
        JsonNode changed = manage("bank", "item", "delete", "remove.json", null, null).body();
        assertTrue(changed.at("/catalog/banks/0").has("error"), changed.toString());
    }
    @Test void deletingNewestUnusedExtensionExposesItsPreviousVersion() throws Exception {
        Path source = root.resolve("extensions/generic"), newer = root.resolve("extensions/generic-new"); Files.createDirectory(newer);
        try (var files = Files.list(source)) { for (Path file : files.toList()) Files.copy(file, newer.resolve(file.getFileName())); }
        for (String file : java.util.List.of("manifest.json", "examples.json")) fixture.write("extensions/generic-new/" + file, Files.readString(newer.resolve(file)).replace("1.0.0", "2.0.0"));
        enable(); assertEquals("2.0.0", catalog().at("/extensions/0/version").asText());
        var changed = manage("extension", "item", "delete", "generic-new", null, null); assertEquals(200, changed.status(), changed.body().toString());
        assertEquals("1.0.0", changed.body().at("/catalog/extensions/0/version").asText()); assertEquals(200, fixture.get(ServerTest.QUESTION).status());
    }
    @Test void redirectedDirectoriesCannotBeMovedOrArchived() throws Exception {
        Path outside = root.resolve("outside"); Files.createDirectory(outside);
        try { Files.createSymbolicLink(root.resolve("question-banks/link"), outside); } catch (java.io.IOException | UnsupportedOperationException unavailable) { return; }
        assertThrows(ApiException.class, () -> BankDirectories.scan(root.resolve("question-banks"))); assertTrue(Files.exists(outside));
    }
}

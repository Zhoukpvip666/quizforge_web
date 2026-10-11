package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class MixedDevelopmentBankTest {
    @TempDir Path root;
    final ServerTest fixture = new ServerTest();
    static final String BANK = "/api/collections/development-bank/mixed-dev";
    static final String DESCRIPTOR = "/api/development/banks/mixed-dev";

    @BeforeEach void prepare() throws Exception {
        fixture.root = root; fixture.prepare();
        development("first-dev", "first"); development("second-dev", "second");
        ObjectNode bank = (ObjectNode) Json.read(root.resolve("question-banks/bank.json"), 8 * 1024 * 1024);
        bank.put("id", "mixed-dev").put("title", "Mixed development bank");
        bank.set("extension", Json.object().put("development", "first-dev"));
        ((ObjectNode) bank.path("questions").get(1)).set("extension", Json.object().put("development", "second-dev"));
        ObjectNode formal = ((ObjectNode) bank.path("questions").get(0)).deepCopy().put("id", "q3");
        formal.set("extension", Json.object().put("id", "generic").put("version", "1.0.0"));
        ((ArrayNode) bank.path("questions")).add(formal);
        fixture.write("question-banks/mixed-dev.json", bank.toString());
    }
    @AfterEach void close() { fixture.close(); }

    void development(String folder, String id) throws Exception {
        Path source = root.resolve("extensions/generic"), target = root.resolve("extensions/" + folder);
        try (var paths = Files.walk(source)) {
            for (Path file : paths.toList()) {
                Path copy = target.resolve(source.relativize(file));
                if (Files.isDirectory(file)) Files.createDirectories(copy); else Files.copy(file, copy);
            }
        }
        ObjectNode manifest = (ObjectNode) Json.read(target.resolve("manifest.json"), 256 * 1024);
        manifest.put("id", id); fixture.write("extensions/" + folder + "/manifest.json", manifest.toString());
        ObjectNode examples = (ObjectNode) Json.read(target.resolve("examples.json"), 8 * 1024 * 1024);
        ((ObjectNode) examples.path("extension")).put("id", id);
        fixture.write("extensions/" + folder + "/examples.json", examples.toString());
        fixture.write("extensions/" + folder + "/development.json", "{}");
        fixture.write("extensions/" + folder + "/page.css", "article{--owner:" + id + "}");
        fixture.write("extensions/" + folder + "/editor.json", "{\"entry\":\"page.html\",\"script\":\"page.js\",\"style\":\"page.css\"}");
    }
    void start() throws Exception {
        fixture.start(null);
        var enabled = fixture.call("PUT", "/api/settings/development", "{\"enabled\":true}", null,
                "http://127.0.0.1:" + fixture.server.port());
        assertEquals(200, enabled.status(), enabled.body().toString());
    }
    JsonNode get(String path) throws Exception {
        var reply = fixture.get(path); assertEquals(200, reply.status(), reply.body().toString()); return reply.body();
    }
    JsonNode submit(String qid, String answer) throws Exception {
        String path = BANK + "/questions/" + qid;
        long revision = get(path).at("/state/revision").asLong();
        var reply = fixture.post(path + "/actions", fixture.action("submit-" + qid + "-mixed", revision, "submit", fixture.answer(answer)));
        assertEquals(200, reply.status(), reply.body().toString()); return reply.body();
    }
    JsonNode row() throws Exception { return DevelopmentExtensionsTest.row(get("/api/catalog").path("banks"), "mixed-dev"); }

    @Test void multipleDevelopmentAndFormalTypesLoadEditAndPersistInTheirOwnStores() throws Exception {
        start(); assertFalse(row().has("error"), row().toString());
        assertEquals(3, get(BANK).path("questions").size());
        JsonNode descriptor = get(DESCRIPTOR);
        assertEquals(Json.MAPPER.readTree("[\"first-dev\",\"second-dev\"]"), descriptor.at("/development/folders"));
        assertFalse(descriptor.path("development").has("folder"));
        assertEquals(3, descriptor.path("extensions").size()); assertTrue(descriptor.path("canEdit").asBoolean());
        assertEquals(descriptor.path("revision"), get(DESCRIPTOR + "/revision").path("revision"));
        String[] owners = {"dev.first-dev", "dev.second-dev", "generic"};
        for (int i = 0; i < owners.length; i++) {
            JsonNode question = get(BANK + "/questions/q" + (i + 1));
            assertEquals(owners[i], question.at("/extension/id").asText());
            assertFalse(question.path("question").path("data").has("secret"));
        }
        JsonNode editor = get(BANK + "/questions/q2/editor");
        assertEquals("dev.second-dev", editor.at("/extension/id").asText());
        assertTrue(editor.at("/editor/style").asText().contains("--owner:second"));
        ObjectNode data = ((ObjectNode) editor.at("/question/data")).deepCopy().put("public", "Edited second question");
        ObjectNode edit = Json.object().put("requestId", "edit-mixed-second").put("title", "Second edited")
                .put("revision", editor.path("revision").asLong()).put("contentVersion", editor.path("contentVersion").asText());
        edit.set("data", data);
        var saved = fixture.post(BANK + "/questions/q2/edit", edit);
        assertEquals(200, saved.status(), saved.body().toString());
        assertEquals("Edited second question", get(BANK + "/questions/q2").at("/question/data/public").asText());
        submit("q1", "yes"); submit("q2", "no"); submit("q3", "yes");
        assertEquals(3, get(BANK + "/summary").path("score").asInt());
        assertEquals("unanswered", get(ServerTest.QUESTION).at("/state/status").asText(), "Development testing cannot change formal practice.");
        JsonNode state = get(BANK + "/questions/q2").path("state");
        fixture.server.close(); fixture.server = null; fixture.start(null);
        assertEquals(state, get(BANK + "/questions/q2").path("state"));
        assertTrue(Files.isDirectory(root.resolve(".development/.state")));
    }

    @Test void changesInEitherDevelopmentTypeReloadWhileOnlyChangedRulesResetTheirAnswers() throws Exception {
        start(); submit("q1", "yes"); submit("q2", "no"); submit("q3", "yes");
        JsonNode first = get(BANK + "/questions/q1").path("state"), second = get(BANK + "/questions/q2").path("state"), formal = get(BANK + "/questions/q3").path("state");
        String historyId = get(BANK + "/history").at("/records/0/id").asText();
        JsonNode frozen = get(BANK + "/history/" + historyId);
        assertTrue(frozen.toString().contains("--owner:first")); assertTrue(frozen.toString().contains("--owner:second"));
        for (String folder : new String[]{"second-dev", "first-dev"}) {
            String before = get(DESCRIPTOR + "/revision").path("revision").asText();
            fixture.write("extensions/" + folder + "/page.css", "article{color:#123456;--owner:" + folder + "}");
            assertNotEquals(before, get(DESCRIPTOR + "/revision").path("revision").asText());
            assertEquals(get(DESCRIPTOR).path("revision"), get(DESCRIPTOR + "/revision").path("revision"));
            assertEquals(first, get(BANK + "/questions/q1").path("state"));
            assertEquals(second, get(BANK + "/questions/q2").path("state"));
            assertEquals(frozen, get(BANK + "/history/" + historyId));
        }
        Path rules = root.resolve("extensions/second-dev/rules.js");
        fixture.write("extensions/second-dev/rules.js", Files.readString(rules).replace("maxScore:1", "maxScore:2"));
        assertEquals("unanswered", get(BANK + "/questions/q2").at("/state/status").asText());
        assertEquals(first, get(BANK + "/questions/q1").path("state"));
        assertEquals(formal, get(BANK + "/questions/q3").path("state"));
        JsonNode interrupted = get(BANK + "/history/" + historyId);
        assertEquals(frozen.path("questions"), interrupted.path("questions"));
        assertEquals(frozen.path("pages"), interrupted.path("pages"));
    }

    @Test void missingTypeIsReportedAndDeveloperModeStillControlsAccess() throws Exception {
        start();
        ObjectNode bank = (ObjectNode) Json.read(root.resolve("question-banks/mixed-dev.json"), 8 * 1024 * 1024);
        ((ObjectNode) bank.path("questions").get(1)).set("extension", Json.object().put("development", "missing-dev"));
        fixture.write("question-banks/mixed-dev.json", bank.toString());
        assertTrue(row().has("error")); assertEquals(404, fixture.get(BANK).status());
        assertEquals(404, fixture.get(DESCRIPTOR + "/revision").status());
        assertEquals(200, fixture.get(ServerTest.QUESTION).status());
        var disabled = fixture.call("PUT", "/api/settings/development", "{\"enabled\":false}", null,
                "http://127.0.0.1:" + fixture.server.port());
        assertEquals(200, disabled.status()); assertEquals(1, get("/api/catalog").path("banks").size());
        assertEquals(404, fixture.get(DESCRIPTOR).status());
    }
}

package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.nio.file.Files;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.UUID;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import static org.junit.jupiter.api.Assertions.*;

/** Temporary exams must have the same page isolation and bounded lifetime as temporary practice. */
class TemporaryExamRegressionTest {
    @TempDir Path root;
    ServerTest fixture;
    AiGradingService ai;
    ExamSessions exams;
    Library library;
    final Time time = new Time();
    final String pageSession = UUID.randomUUID().toString();

    static final class Time extends Clock {
        Instant now = Instant.parse("2026-10-11T00:00:00Z");
        public ZoneId getZone() { return ZoneId.of("UTC"); }
        public Clock withZone(ZoneId zone) { return this; }
        public Instant instant() { return now; }
    }
    @BeforeEach void prepare() throws Exception {
        fixture = new ServerTest(); fixture.root = root; fixture.prepare();
        ObjectNode bank = (ObjectNode) Json.read(root.resolve("question-banks/bank.json"), 1024 * 1024);
        bank.putObject("features").put("history", false); fixture.write("question-banks/bank.json", bank.toString());
    }
    void setup() throws Exception {
        RuleEngine engine = new RuleEngine(root, "node", java.time.Duration.ofSeconds(8));
        library = new Library(root, engine); StateStore states = new StateStore(root, engine);
        ai = new AiGradingService(root, states, library, request -> { throw new AssertionError("Unexpected provider request"); });
        CollectionRoutes.Writes writes = new CollectionRoutes.Writes() {
            public JsonNode read(com.sun.net.httpserver.HttpExchange exchange) { throw new UnsupportedOperationException(); }
            public void validateOrigin(com.sun.net.httpserver.HttpExchange exchange) { }
        };
        var routes = new CollectionRoutes(library, states, ai, writes, () -> false);
        exams = new ExamSessions(root, library, states, ai, routes, writes, () -> false, time);
    }
    JsonNode start(int index) {
        return exams.start(library.collection("bank", "bank"), Json.object().put("requestId", "temporary-start-" + index).putNull("durationMinutes"), pageSession);
    }
    ServerTest.Reply call(String method, String path, JsonNode body, String session) throws Exception {
        String base = "http://127.0.0.1:" + fixture.server.port();
        var request = HttpRequest.newBuilder(URI.create(base + path)).timeout(java.time.Duration.ofSeconds(15));
        if (session != null) request.header("X-QuizForge-Practice-Session", session);
        if (!method.equals("GET")) request.header("Origin", base);
        if (body != null) request.header("Content-Type", "application/json");
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body.toString()));
        var response = fixture.client.send(request.build(), HttpResponse.BodyHandlers.ofString());
        return new ServerTest.Reply(response.statusCode(), Json.MAPPER.readTree(response.body()), response);
    }
    @AfterEach void close() { if (exams != null) exams.close(); if (ai != null) ai.close(); if (fixture != null) fixture.close(); }

    @Test void httpCannotCreateSharedHeaderlessTemporaryExam() throws Exception {
        fixture.start(null);
        var reply = fixture.post("/api/collections/bank/bank/exams", Json.object().put("requestId", "headerless-exam-start").putNull("durationMinutes"));
        assertEquals(409, reply.status(), reply.body().toString());
        assertEquals("PRACTICE_SESSION_REQUIRED", reply.body().at("/error/code").asText());
    }
    @Test void capacityRefusesAnotherAttemptWithoutRemovingSavedLiveAttempts() throws Exception {
        setup(); String first = start(0).path("id").asText();
        for (int index = 1; index < 32; index++) start(index);
        ApiException limit = assertThrows(ApiException.class, () -> start(32));
        assertEquals("PRACTICE_SESSION_LIMIT", limit.code);
        assertEquals(32, exams.list("bank", "bank", pageSession).path("records").size());
        assertEquals(first, library.collection("exam", first).id());
    }
    @Test void abandonedPageAttemptsExpireAndCannotBeResumed() throws Exception {
        setup(); String expired = start(0).path("id").asText();
        Path snapshot = root.resolve(".state/exams/" + expired); assertTrue(Files.isDirectory(snapshot.resolve("packages")));
        time.now = time.now.plusSeconds(31 * 60);
        assertEquals(0, exams.list("bank", "bank", pageSession).path("records").size());
        assertFalse(Files.exists(snapshot));
        assertEquals(404, assertThrows(ApiException.class, () -> library.collection("exam", expired)).status);
        assertEquals("in-progress", start(1).path("status").asText());
    }
    @Test void ownerCanSaveAndDeleteWhileOtherPagesCannotReadOrResume() throws Exception {
        fixture.start(null); String bank = "/api/collections/bank/bank";
        var command = Json.object().put("requestId", "isolated-exam-start").putNull("durationMinutes");
        assertEquals(400, call("POST", bank + "/exams", command, "invalid-session").status());
        var started = call("POST", bank + "/exams", command, pageSession); assertEquals(200, started.status(), started.body().toString());
        String id = started.body().path("id").asText(), base = "/api/collections/exam/" + id;
        String other = UUID.randomUUID().toString();
        assertEquals(409, fixture.get(base).status()); assertEquals(404, call("GET", base, null, other).status());
        assertEquals(0, call("GET", bank + "/exams", null, other).body().path("records").size());
        var saved = call("POST", base + "/questions/q1/actions", fixture.action("temporary-live-answer", 0, "draft", fixture.answer("yes")), pageSession);
        assertEquals(200, saved.status(), saved.body().toString());
        assertEquals("yes", call("GET", base + "/questions/q1", null, pageSession).body().at("/state/answer/value").asText());
        assertEquals(404, call("DELETE", base + "/exam", null, other).status());
        assertEquals(200, call("DELETE", base + "/exam", null, pageSession).status());
        assertFalse(Files.exists(root.resolve(".state/exams/" + id)));
        assertEquals(200, call("DELETE", base + "/exam", null, pageSession).status());
        assertEquals(409, call("POST", bank + "/exams", command, pageSession).status());
        assertEquals(404, call("GET", base, null, pageSession).status());
    }
    @Test void livePageActivityRetainsAttemptsAndDeletedAttemptReleasesCapacity() throws Exception {
        setup(); String first = start(0).path("id").asText();
        time.now = time.now.plusSeconds(29 * 60); assertEquals(1, exams.list("bank", "bank", pageSession).path("records").size());
        time.now = time.now.plusSeconds(2 * 60); assertEquals(1, exams.list("bank", "bank", pageSession).path("records").size());
        for (int index = 1; index < 32; index++) start(index);
        assertThrows(ApiException.class, () -> start(32)); exams.delete(first, pageSession);
        assertEquals("in-progress", start(32).path("status").asText());
        assertEquals(32, exams.list("bank", "bank", pageSession).path("records").size());
    }
    @Test void failedTemporaryStartDisposesRuntimeAndGeneratedPackageTree() throws Exception {
        ObjectNode bank = (ObjectNode) Json.read(root.resolve("question-banks/bank.json"), 1024 * 1024);
        for (JsonNode question : bank.path("questions")) ((ObjectNode) question).putObject("outline").put("level", "parts").putArray("items").addObject().put("id", "part").put("label", "Part");
        fixture.write("question-banks/bank.json", bank.toString());
        fixture.write("extensions/generic/rules.js", "QF.defineType({project(d){return {public:d.public};},validateQuestion(){return true;},getScore(){throw Error('unavailable');},grade(){return {score:0,maxScore:1,correct:false};}});");
        setup(); assertThrows(ApiException.class, () -> start(0));
        assertEquals(0, exams.list("bank", "bank", pageSession).path("records").size());
        try (var folders = Files.list(root.resolve(".state/exams"))) { assertEquals(0, folders.count()); }
    }
    @Test void disposalPreservesDurableSnapshotsAndUnrelatedFiles() throws Exception {
        setup(); String temporaryId = start(0).path("id").asText();
        Path temporaryFolder = root.resolve(".state/exams/" + temporaryId); Path unrelated = temporaryFolder.resolve("personal-note.txt"); Files.writeString(unrelated, "keep");
        ObjectNode bank = (ObjectNode) Json.read(root.resolve("question-banks/bank.json"), 1024 * 1024);
        bank.putObject("features").put("history", true); fixture.write("question-banks/bank.json", bank.toString());
        String durableId = exams.start(library.collection("bank", "bank"), Json.object().put("requestId", "durable-preserved-start").putNull("durationMinutes")).path("id").asText();
        Path durable = root.resolve(".state/exams/" + durableId); byte[] metadata = Files.readAllBytes(durable.resolve("exam.json"));
        exams.delete(temporaryId, pageSession); assertEquals("keep", Files.readString(unrelated));
        assertArrayEquals(metadata, Files.readAllBytes(durable.resolve("exam.json"))); assertTrue(Files.exists(durable.resolve("snapshot.json")));
        exams.close(); assertArrayEquals(metadata, Files.readAllBytes(durable.resolve("exam.json")));
    }
    @Test void publicMetadataRetainsExactFieldsAndCannotMutateTheStoredAttempt() throws Exception {
        setup(); ObjectNode started = (ObjectNode) start(0); String id = started.path("id").asText();
        var fields = new java.util.HashSet<String>(); started.fieldNames().forEachRemaining(fields::add);
        assertEquals(java.util.Set.of("id", "bankKind", "bankId", "title", "startedAt", "status", "durationMinutes", "deadline", "questionCount", "serverTime"), fields);
        ObjectNode initial = started.deepCopy(); started.put("title", "client mutation"); assertEquals(initial, start(0));
        ObjectNode completed = exams.submit(id), expected = completed.deepCopy();
        ((ObjectNode) completed.path("summary")).put("score", 999);
        ((ObjectNode) completed.at("/summary/questions/0")).put("maxScore", 999);
        assertEquals(expected, exams.submit(id));
        for (String key : java.util.List.of("packages", "questions", "features", "requestId", "description", "pageSession")) assertFalse(expected.has(key), key);
    }
}

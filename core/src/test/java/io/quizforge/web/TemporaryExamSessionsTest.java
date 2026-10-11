package io.quizforge.web;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import static org.junit.jupiter.api.Assertions.*;

class TemporaryExamSessionsTest {
    @TempDir Path root;
    ServerTest fixture;
    RuleEngine engine;
    Library library;
    final TemporaryExamRegressionTest.Time time = new TemporaryExamRegressionTest.Time();
    final String owner = UUID.randomUUID().toString();
    final TemporaryExamSessions sessions = new TemporaryExamSessions(time);

    @BeforeEach void prepare() throws Exception {
        fixture = new ServerTest(); fixture.root = root; fixture.prepare();
        ObjectNode bank = (ObjectNode) Json.read(root.resolve("question-banks/bank.json"), 1024 * 1024);
        bank.putObject("features").put("history", false); fixture.write("question-banks/bank.json", bank.toString());
        engine = new RuleEngine(root, "node", Duration.ofSeconds(8)); library = new Library(root, engine);
    }
    TemporaryExamSessions.Runtime runtime(AiGateway gateway) throws Exception {
        StateStore memory = StateStore.memory(root, engine, root); ResourceStore resources = ResourceStore.memory(root, null);
        AiGradingService ai = AiGradingService.memory(root, memory, library, gateway);
        CollectionRoutes.Writes writes = new CollectionRoutes.Writes() {
            public com.fasterxml.jackson.databind.JsonNode read(com.sun.net.httpserver.HttpExchange exchange) { throw new UnsupportedOperationException(); }
            public void validateOrigin(com.sun.net.httpserver.HttpExchange exchange) { }
        };
        return new TemporaryExamSessions.Runtime(memory, ai, new CollectionRoutes(library, memory, ai, writes, () -> false), resources);
    }
    @AfterEach void close() { sessions.close(); if (fixture != null) fixture.close(); }

    @Test void snapshotsAndRuntimeBytesShareWriteHeadroomAndDeletionReceiptsStayBounded() throws Exception {
        var runtime = runtime(request -> { throw new AssertionError("Unexpected provider request"); });
        String id = UUID.randomUUID().toString(); sessions.add(id, owner, runtime, 224L * 1024 * 1024);
        assertEquals("PRACTICE_SESSION_LIMIT", assertThrows(ApiException.class, () -> sessions.checkAdmission(1)).code);
        byte[] image = new byte[24]; byte[] header = {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10}; System.arraycopy(header, 0, image, 0, header.length);
        System.arraycopy(new byte[]{'I', 'H', 'D', 'R'}, 0, image, 12, 4);
        runtime.resources().upload(Json.object().put("mime", "image/png").put("data", Base64.getEncoder().encodeToString(image)));
        assertThrows(ApiException.class, () -> sessions.access(id, owner, true));
        sessions.access(id, owner, false); assertSame(runtime, sessions.runtime(id));
        var invalidated = new ArrayList<String>(); sessions.deleted(id, 128, invalidated::add);
        assertEquals(0, runtime.resources().memoryBytes()); sessions.checkAdmission(0);
        for (int index = 0; index < 256; index++) {
            String deleted = UUID.randomUUID().toString(); sessions.add(deleted, owner, runtime, 0); sessions.deleted(deleted, 128, invalidated::add);
        }
        assertEquals(java.util.List.of(id), invalidated);
        time.now = time.now.plusSeconds(31 * 60); sessions.expire(invalidated::add); assertEquals(257, invalidated.size());
    }
    @Test void expiryInvalidatesBeforeClosingAndDiscardsLateProviderResults() throws Exception {
        fixture.write("extensions/generic/rules.js", """
            QF.defineType({project(d,s){return s.submitted?{reveal:d.secret}:{public:d.public};},grade(){return {gradingStatus:'graded',score:0,maxScore:1,correct:false,feedback:'awaiting AI review'};},getScore(d,s){return {score:s.submitted?s.result.score:0,maxScore:1};},
            prepareAiGrading(d,a){return {protocolVersion:1,question:[{type:'text',text:d.public}],answer:[{type:'text',text:a.value}],referenceAnswer:[{type:'text',text:d.secret}],maxScore:1,scoreStep:1};},
            review(d,a,r){return {gradingStatus:'graded',score:r.score,maxScore:1,correct:r.score===1,feedback:r.feedback};}});
            """);
        var entered = new CountDownLatch(1); var released = new CountDownLatch(1); var returned = new CountDownLatch(1);
        var runtime = runtime(request -> {
            entered.countDown();
            // Deliberately emulate a provider that returns even after shutdown interruption.
            boolean interrupted = false;
            for (;;) try { if (released.await(10, TimeUnit.SECONDS)) break; else throw new AssertionError("Provider release timed out"); }
            catch (InterruptedException error) { interrupted = true; }
            if (interrupted) Thread.currentThread().interrupt(); returned.countDown();
            return new AiGateway.Response("{\"score\":1,\"feedback\":\"late\"}", "mock", "mock", "id", Json.object());
        });
        String id = UUID.randomUUID().toString(); sessions.add(id, owner, runtime, 0);
        var collection = library.collection("bank", "bank"); var question = collection.question("q1");
        runtime.states().act(collection, question, fixture.action("temporary-submit", 0, "submit", fixture.answer("yes")));
        runtime.ai().start(collection, question, Json.object().put("requestId", "temporary-ai-start")); assertTrue(entered.await(5, TimeUnit.SECONDS));
        try {
            time.now = time.now.plusSeconds(31 * 60);
            sessions.expire(expired -> { assertEquals(id, expired); assertTrue(runtime.states().memoryBytes() > 0); assertNull(sessions.runtime(id)); });
            released.countDown(); assertTrue(returned.await(5, TimeUnit.SECONDS));
            assertEquals("unanswered", runtime.states().question(collection, question).at("/state/status").asText());
            assertTrue(runtime.states().question(collection, question).at("/state/result").isNull());
        } finally { released.countDown(); runtime.close(); }
    }
}

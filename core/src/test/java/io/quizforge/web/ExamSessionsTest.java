package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class ExamSessionsTest {
    @TempDir Path root;
    ServerTest fixture; RuleEngine engine; Library library; StateStore states; AiGradingService ai; ExamSessions exams;
    final Time time = new Time(); final AtomicInteger calls = new AtomicInteger(); boolean automatic, failProvider;
    final String pageSession = java.util.UUID.randomUUID().toString();
    java.util.concurrent.CountDownLatch responseEntered, responseRelease;
    static class Time extends Clock {
        Instant now = Instant.parse("2026-10-10T10:00:00Z");
        public ZoneId getZone() { return ZoneId.of("UTC"); }
        public Clock withZone(ZoneId zone) { return this; }
        public Instant instant() { return now; }
    }
    @BeforeEach void prepare() throws Exception { fixture = new ServerTest(); fixture.root = root; fixture.prepare(); enable(true); }
    void enable(boolean history) throws Exception {
        ObjectNode bank = (ObjectNode) Json.read(root.resolve("question-banks/bank.json"), 1024 * 1024);
        bank.set("features", Json.object().put("exam", true).put("history", history)); fixture.write("question-banks/bank.json", bank.toString());
    }
    void setup(boolean failAi) throws Exception {
        failProvider = failAi;
        engine = new RuleEngine(root, "node", java.time.Duration.ofSeconds(8)); library = new Library(root, engine); states = new StateStore(root, engine);
        ai = new AiGradingService(root, states, library, request -> {
            if (responseEntered != null) { responseEntered.countDown(); try { responseRelease.await(10, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AiProviderException("AI_INTERRUPTED", false, 0); } }
            calls.incrementAndGet(); if (failProvider) throw new AiProviderException("AI_HTTP_ERROR", false, 400);
            return new AiGateway.Response("{\"score\":1,\"feedback\":\"ok\"}", "mock", "mock", "id", Json.object());
        });
        CollectionRoutes.Writes writes = new CollectionRoutes.Writes() {
            public JsonNode read(com.sun.net.httpserver.HttpExchange exchange) { throw new UnsupportedOperationException(); }
            public void validateOrigin(com.sun.net.httpserver.HttpExchange exchange) { }
        };
        var routes = new CollectionRoutes(library, states, ai, writes, () -> automatic);
        exams = new ExamSessions(root, library, states, ai, routes, writes, () -> automatic, time);
    }
    JsonNode start(Integer duration, String requestId) { var command = Json.object().put("requestId", requestId); if (duration == null) command.putNull("durationMinutes"); else command.put("durationMinutes", duration); return exams.start(library.collection("bank", "bank"), command, pageSession); }
    void answer(String examId, String qid, String value) { var collection = library.collection("exam", examId); var q = collection.question(qid); states.act(collection, q, fixture.action("draft-" + qid + "-" + value, states.stamp(collection,q).path("revision").asLong(), "draft", fixture.answer(value))); }
    @AfterEach void close() { if (exams != null) exams.close(); if (ai != null) ai.close(); if (fixture != null) fixture.close(); }

    @Test void handInUsesSavedAnswersAndFrozenRulesWithoutChangingPractice() throws Exception {
        setup(false); var practice = library.collection("bank", "bank"); states.act(practice, practice.question("q1"), fixture.action("practice-existing",0,"draft",fixture.answer("no")));
        JsonNode before = states.overview(practice), begun = start(null,"exam-start-one"); String id = begun.path("id").asText();
        assertEquals(id,start(null,"exam-start-one").path("id").asText());
        answer(id,"q1","yes"); var frozen = library.collection("exam", id);
        assertFalse(states.question(frozen,frozen.question("q1")).path("question").path("data").has("reveal"));
        fixture.write("extensions/generic/rules.js","QF.defineType({project(){return {};},grade(){throw Error('changed');}});");
        JsonNode done = exams.submit(id); assertEquals("completed",done.path("status").asText()); assertEquals(1,done.at("/summary/score").asInt()); assertEquals(1,done.at("/summary/submittedCount").asInt());
        assertEquals("yes",states.question(frozen,frozen.question("q1")).at("/state/answer/value").asText());
        assertEquals("no",before.at("/states/q1/answer/value").asText()); assertEquals("completed",exams.submit(id).path("status").asText());
        assertTrue(states.history("exam",id,done.at("/summary/historyId").asText()).has("questions"));
        assertEquals(1,states.stamp(practice,practice.question("q1")).path("revision").asLong());
    }
    @Test void deadlineIsServerOwnedAndUnlimitedAttemptKeepsCounting() throws Exception {
        setup(false); String timed = start(1,"exam-timed-one").path("id").asText(), unlimited = start(null,"exam-unlimited").path("id").asText(); answer(timed,"q1","yes");
        time.now = time.now.plusSeconds(59); exams.tick(); assertEquals("in-progress",exams.list("bank","bank").at("/records/0/status").asText());
        time.now = time.now.plusSeconds(1); exams.tick();
        var records = exams.list("bank","bank").path("records");
        for (JsonNode record : records) if (record.path("id").asText().equals(timed)) { assertEquals("completed",record.path("status").asText()); assertEquals("timeout",record.path("submissionReason").asText()); }
        else { assertEquals(unlimited,record.path("id").asText()); assertEquals("in-progress",record.path("status").asText()); }
    }
    @Test void restartRestoresDeadlineSnapshotsAndAnswers() throws Exception {
        setup(false); String id = start(1,"exam-restart-one").path("id").asText(); answer(id,"q1","yes"); exams.close(); ai.close(); exams=null; ai=null; engine=null;
        time.now=time.now.plusSeconds(90); setup(false); exams.tick(); var done=exams.list("bank","bank").path("records").get(0); assertEquals(id,done.path("id").asText()); assertEquals("timeout",done.path("submissionReason").asText()); assertEquals(1,done.at("/summary/score").asInt());
    }
    @Test void crashAfterLockResumesSubmissionInsteadOfCompletingWithUnsubmittedAnswers() throws Exception {
        setup(false); String id=start(null,"exam-crash-lock").path("id").asText();answer(id,"q1","yes");
        Path file=root.resolve(".state/exams/"+id+"/exam.json");ObjectNode record=(ObjectNode)Json.read(file,1024*1024);record.put("status","grading").put("submittedAt",time.now.toString()).put("submissionReason","manual").put("submissionComplete",false);Files.write(file,Json.MAPPER.writeValueAsBytes(record));
        exams.close();ai.close();exams=null;ai=null;setup(false);exams.tick();var done=exams.list("bank","bank").path("records").get(0);assertEquals("completed",done.path("status").asText());assertEquals(1,done.at("/summary/score").asInt());
        record=(ObjectNode)Json.read(file,1024*1024);record.put("status","grading").remove("summary");Files.write(file,Json.MAPPER.writeValueAsBytes(record));exams.close();ai.close();exams=null;ai=null;setup(false);exams.tick();assertEquals("completed",exams.list("bank","bank").path("records").get(0).path("status").asText());
    }
    @Test void badSavedAnswerLocksAttemptButPreservesAllAnswersForRetry() throws Exception {
        setup(false); String id=start(null,"exam-invalid-one").path("id").asText(); var collection=library.collection("exam",id);
        // Simulate a type whose final grade cannot handle a partial answer.
        Path rules=collection.extensionFor(collection.question("q1")).rules(); Files.writeString(rules,Files.readString(rules).replace("const correct=", "if(answer.value==='yes')throw Error('incomplete grading');const correct="));
        // The engine compiles this frozen file for the first time below.
        answer(id,"q1","yes"); answer(id,"q2","no"); JsonNode result=exams.submit(id); assertEquals("grading",result.path("status").asText()); assertEquals(1,result.path("gradingErrors").size()); assertEquals("yes",states.question(collection,collection.question("q1")).at("/state/answer/value").asText());
    }
    @Test void aiFailureRemainsPendingAndManualReviewCompletesExam() throws Exception {
        fixture.write("extensions/generic/rules.js", """
            QF.defineType({project(d,s){return s.submitted?{reveal:d.secret}:{public:d.public};},grade(d,a){return {gradingStatus:'graded',score:0,maxScore:1,correct:false,feedback:null};},getScore(d,s){return {score:s.submitted?s.result.score:0,maxScore:1};},
            prepareAiGrading(d,a){return {protocolVersion:1,question:[{type:'text',text:d.public}],answer:[{type:'text',text:a.value}],referenceAnswer:[{type:'text',text:d.secret}],maxScore:1,scoreStep:1};},
            review(d,a,r){return {gradingStatus:'graded',score:r.score,maxScore:1,correct:r.score===1,feedback:r.feedback};}});
            """);
        automatic=true; setup(true); String id=start(null,"exam-ai-failure").path("id").asText(); answer(id,"q1","yes"); var submitted=exams.submit(id); assertEquals("grading",submitted.path("status").asText()); assertEquals(0,submitted.path("gradingErrors").size(),submitted.toString());
        var collection=library.collection("exam",id); var question=collection.question("q1"); long end=System.nanoTime()+java.time.Duration.ofSeconds(10).toNanos();
        while(System.nanoTime()<end && !ai.current(collection,question).path("status").asText().equals("failed")) Thread.sleep(20);
        exams.tick(); var row=exams.list("bank","bank").path("records").get(0); assertEquals("grading",row.path("status").asText()); assertEquals(1,row.path("aiErrors").size()); assertEquals(1,calls.get());
        var data=Json.object(); data.putObject("review").put("score",1).put("feedback","人工评分");
        states.act(collection,question,fixture.action("exam-manual-score",states.stamp(collection,question).path("revision").asLong(),"review",data)); exams.tick();
        assertEquals("completed",exams.list("bank","bank").path("records").get(0).path("status").asText()); assertEquals(1,exams.submit(id).at("/summary/score").asInt());
        failProvider=true; String retryId=start(null,"exam-ai-retry").path("id").asText(); answer(retryId,"q1","yes"); exams.submit(retryId);
        var retryCollection=library.collection("exam",retryId); var retryQuestion=retryCollection.question("q1"); end=System.nanoTime()+java.time.Duration.ofSeconds(10).toNanos();
        while(System.nanoTime()<end && !ai.current(retryCollection,retryQuestion).path("status").asText().equals("failed")) Thread.sleep(20);
        failProvider=false; exams.submit(retryId); end=System.nanoTime()+java.time.Duration.ofSeconds(15).toNanos();
        while(System.nanoTime()<end && !ai.current(retryCollection,retryQuestion).path("status").asText().equals("confirmed")) Thread.sleep(20);
        assertEquals("confirmed",ai.current(retryCollection,retryQuestion).path("status").asText()); exams.tick(); assertEquals("completed",exams.submit(retryId).path("status").asText()); assertEquals(3,calls.get());
    }
    @Test void examChildDraftStatesAreVisibleBeforeHandInWithoutAnswerKeysOrGrades() throws Exception {
        ObjectNode manifest = (ObjectNode) Json.read(root.resolve("extensions/generic/manifest.json"), 1024 * 1024);
        manifest.putObject("requiresApi").put("major", 1).put("minMinor", 2).putArray("capabilities").add("practice").add("score").add("outline-items");
        fixture.write("extensions/generic/manifest.json", manifest.toString());
        fixture.write("extensions/generic/rules.js", OutlineStatesTest.RULES);
        ObjectNode bank = (ObjectNode) Json.read(root.resolve("question-banks/bank.json"), 1024 * 1024);
        for (JsonNode question : bank.path("questions")) {
            var items = ((ObjectNode) question).putObject("outline").put("level", "parts").putArray("items");
            items.addObject().put("id", "part-21").put("label", "21"); items.addObject().put("id", "part-22").put("label", "22");
        }
        fixture.write("question-banks/bank.json", bank.toString()); fixture.start(null);
        var started = fixture.post("/api/collections/bank/bank/exams", Json.object().put("requestId", "exam-child-start").putNull("durationMinutes"));
        assertEquals(200, started.status(), started.body().toString());
        String base = "/api/collections/exam/" + started.body().path("id").asText(), q = base + "/questions/q1";
        var saved = fixture.post(q + "/actions", fixture.action("exam-child-draft", 0, "draft", fixture.answer("yes")));
        assertEquals(200, saved.status(), saved.body().toString());
        assertEquals("draft", saved.body().at("/state/outlineStates/0/status").asText());
        assertEquals("unanswered", saved.body().at("/state/outlineStates/1/status").asText());
        assertTrue(saved.body().at("/state/result").isNull()); assertFalse(saved.body().at("/question/data").has("reveal"));
        assertEquals("draft", fixture.get(base).body().at("/states/q1/outlineStates/0/status").asText());
        assertEquals("unanswered", fixture.get(base).body().at("/states/q2/outlineStates/0/status").asText());
        var done = fixture.post(base + "/exam", Json.object().put("requestId", "exam-child-handin"));
        assertEquals(200, done.status(), done.body().toString());
        assertEquals("correct", fixture.get(q).body().at("/state/outlineStates/0/status").asText());
    }

    @Test void httpGuardsSubmitEditAiAndPostHandInWrites() throws Exception {
        fixture.start(null); String bank="/api/collections/bank/bank";
        assertTrue(fixture.get(bank).body().at("/features/exam").asBoolean());
        JsonNode begin=fixture.post(bank+"/exams",Json.object().put("requestId","exam-http-start").putNull("durationMinutes")).body(); String base="/api/collections/exam/"+begin.path("id").asText();
        assertEquals("in-progress",fixture.get(base).body().path("exam").path("status").asText());
        String q=base+"/questions/q1"; assertEquals(403,fixture.get(q+"/editor").status()); assertEquals(403,fixture.get(base+"/summary").status());
        assertEquals(403,fixture.post(q+"/actions",fixture.action("exam-http-submit",0,"submit",fixture.answer("yes"))).status());
        assertEquals(403,fixture.post(q+"/ai/grade",Json.object().put("requestId","exam-http-ai")).status());
        assertEquals(200,fixture.post(q+"/actions",fixture.action("exam-http-draft",0,"draft",fixture.answer("yes"))).status());
        assertFalse(fixture.get(q).body().path("question").path("data").has("reveal")); assertEquals(200,fixture.get(q+"/page").status());
        assertEquals(200,fixture.post(base+"/exam",Json.object().put("requestId","exam-http-handin")).status());
        assertEquals(403,fixture.post(q+"/actions",fixture.action("exam-http-locked",2,"draft",fixture.answer("no"))).status()); assertEquals(403,fixture.post(base+"/restart",Json.object()).status());
        assertEquals("unanswered",fixture.get(bank+"/questions/q1").body().at("/state/status").asText());
        assertEquals(403,fixture.call("POST",bank+"/exams",Json.object().put("requestId","exam-untrusted-start").putNull("durationMinutes").toString(),null,"http://untrusted.example").status());
        for(int invalid:java.util.List.of(0,-1,1441)) assertEquals(400,fixture.post(bank+"/exams",Json.object().put("requestId","exam-invalid-duration").put("durationMinutes",invalid)).status());
        ObjectNode management=Json.object().put("kind","bank").put("target","item").put("action","update").put("path","bank.json").put("name","Test bank").put("group","").put("exam",false);
        assertEquals(400,fixture.post("/api/library/manage",management).status());
        ObjectNode raw=(ObjectNode)Json.read(root.resolve("question-banks/bank.json"),1024*1024);raw.putObject("features").put("exam",false);fixture.write("question-banks/bank.json",raw.toString());
        assertFalse(fixture.get(bank).body().at("/features/exam").asBoolean()); assertEquals(403,fixture.post(bank+"/exams",Json.object().put("requestId","exam-disabled-start").putNull("durationMinutes")).status());
        management.remove("exam");assertEquals(200,fixture.post("/api/library/manage",management).status());assertFalse(fixture.get(bank).body().at("/features/exam").asBoolean());
        raw.remove("features");fixture.write("question-banks/bank.json",raw.toString());assertTrue(fixture.get(bank).body().at("/features/exam").asBoolean());assertEquals(200,fixture.post(bank+"/exams",Json.object().put("requestId","exam-default-restored").putNull("durationMinutes")).status());
        assertEquals("completed",fixture.get(base+"/exam").body().path("status").asText());
    }
    @Test void historyDisabledExamUsesMemoryAndLeavesNoSavedAnswers() throws Exception {
        enable(false); setup(false); String id=start(null,"exam-memory-one").path("id").asText(); assertFalse(Files.exists(root.resolve(".state/exams/"+id+"/exam.json")));
        assertEquals("in-progress",exams.list("bank","bank",pageSession).path("records").get(0).path("status").asText());
        assertTrue(exams.submit(id).at("/summary/historyId").isNull());
    }

    @Test void completedExamsShareBankHistoryAndDeletionSurvivesRestartWithoutChangingPractice() throws Exception {
        fixture.start(null); String bank = "/api/collections/bank/bank";
        assertEquals(200, fixture.post(bank + "/questions/q1/actions", fixture.action("history-practice-answer", 0, "submit", fixture.answer("no"))).status());
        JsonNode practiceRow = fixture.get(bank + "/history").body().path("records").get(0);
        String practicePath = bank + "/history/" + practiceRow.path("id").asText();
        JsonNode practiceHistory = fixture.get(practicePath).body(), practice = fixture.get(bank).body();
        String id = fixture.post(bank + "/exams", Json.object().put("requestId", "history-exam-start").putNull("durationMinutes")).body().path("id").asText();
        String base = "/api/collections/exam/" + id;
        assertEquals(200, fixture.post(base + "/questions/q1/actions", fixture.action("history-exam-answer", 0, "draft", fixture.answer("yes"))).status());
        assertEquals("completed", fixture.post(base + "/exam", Json.object().put("requestId", "history-exam-handin")).body().path("status").asText());
        String pendingId = fixture.post(bank + "/exams", Json.object().put("requestId", "history-exam-pending").putNull("durationMinutes")).body().path("id").asText();
        // Another bank's completed exam must neither appear here nor be readable or deletable here.
        ObjectNode other = (ObjectNode) Json.read(root.resolve("question-banks/bank.json"), 1024 * 1024); other.put("id", "other"); fixture.write("question-banks/other.json", other.toString());
        String otherBank = "/api/collections/bank/other";
        String otherId = fixture.post(otherBank + "/exams", Json.object().put("requestId", "history-other-exam").putNull("durationMinutes")).body().path("id").asText();
        assertEquals(200, fixture.post("/api/collections/exam/" + otherId + "/exam", Json.object().put("requestId", "history-other-handin")).status());
        var list = fixture.get(bank + "/history"); assertEquals(200, list.status(), list.body().toString()); assertEquals(2, list.body().path("records").size());
        JsonNode examRow = list.body().path("records").get(0); assertEquals("exam", examRow.path("mode").asText()); assertEquals(id, examRow.path("examId").asText()); assertEquals("exam-" + id, examRow.path("id").asText());
        assertEquals(1, examRow.path("score").asInt()); assertEquals(2, examRow.path("maxScore").asInt());
        String historyPath = bank + "/history/exam-" + id;
        JsonNode frozen = fixture.get(historyPath).body(); assertEquals("exam", frozen.path("mode").asText()); assertEquals(2, frozen.path("questions").size());
        assertEquals("yes", frozen.at("/questions/0/payload/state/answer/value").asText()); assertEquals("unanswered", frozen.at("/questions/1/payload/state/status").asText());
        String nativeId = fixture.get(base + "/exam").body().at("/summary/historyId").asText();
        JsonNode nativeHistory = fixture.get(base + "/history/" + nativeId).body();
        for (String field : java.util.List.of("questions", "pages", "collection", "summary")) assertEquals(nativeHistory.path(field), frozen.path(field), field);
        assertEquals(404, fixture.get(bank + "/history/exam-" + pendingId).status());
        assertEquals(404, fixture.get(otherBank + "/history/exam-" + id).status()); assertEquals(404, fixture.delete(otherBank + "/history/exam-" + id).status());
        assertEquals(403, fixture.call("DELETE", historyPath, null, null, "https://untrusted.example").status());
        String originalPage = Files.readString(root.resolve("extensions/generic/page.html"));
        fixture.write("extensions/generic/page.html", "<article>New live page</article>");
        fixture.server.close(); fixture.server = null; fixture.start(null);
        assertEquals(frozen, fixture.get(historyPath).body()); assertEquals(2, fixture.get(bank + "/history").body().path("records").size());
        assertEquals(200, fixture.delete(historyPath).status()); assertEquals(404, fixture.get(historyPath).status());
        fixture.write("extensions/generic/page.html", originalPage);
        assertEquals(practiceHistory, fixture.get(practicePath).body()); assertEquals(practice, fixture.get(bank).body());
        fixture.server.close(); fixture.server = null; fixture.start(null);
        assertEquals(1, fixture.get(bank + "/history").body().path("records").size()); assertEquals(404, fixture.get(historyPath).status());
        assertEquals("in-progress", fixture.get("/api/collections/exam/" + pendingId + "/exam").body().path("status").asText());
        assertEquals(1, fixture.get(otherBank + "/history").body().path("records").size());
    }

    @Test void frozenExamHistoryRemainsReadableWithoutItsBankAndHonorsHistoryPolicy() throws Exception {
        fixture.start(null); String bank = "/api/collections/bank/bank";
        String id = fixture.post(bank + "/exams", Json.object().put("requestId", "history-frozen-start").putNull("durationMinutes")).body().path("id").asText();
        fixture.post("/api/collections/exam/" + id + "/exam", Json.object().put("requestId", "history-frozen-handin"));
        String history = bank + "/history/exam-" + id; JsonNode frozen = fixture.get(history).body();
        enable(false); assertEquals(403, fixture.get(bank + "/history").status()); assertEquals(403, fixture.get(history).status()); assertEquals(403, fixture.delete(history).status());
        Files.delete(root.resolve("question-banks/bank.json")); assertEquals(1, fixture.get(bank + "/history").body().path("records").size()); assertEquals(frozen, fixture.get(history).body());
        assertEquals(200, fixture.delete(history).status()); assertEquals(0, fixture.get(bank + "/history").body().path("records").size());
    }

    @Test void deletingUnfinishedExamIsDurableOriginGuardedAndDoesNotChangeOtherRecords() throws Exception {
        fixture.start(null); String bank = "/api/collections/bank/bank";
        fixture.post(bank + "/questions/q1/actions", fixture.action("delete-practice-answer", 0, "submit", fixture.answer("yes")));
        JsonNode practice = fixture.get(bank).body(), history = fixture.get(bank + "/history").body();
        var command = Json.object().put("requestId", "delete-exam-start").put("durationMinutes", 1);
        String id = fixture.post(bank + "/exams", command).body().path("id").asText(), base = "/api/collections/exam/" + id;
        fixture.post(base + "/questions/q1/actions", fixture.action("delete-exam-answer", 0, "draft", fixture.answer("no")));
        String keep = fixture.post(bank + "/exams", Json.object().put("requestId", "delete-keep-other").putNull("durationMinutes")).body().path("id").asText();
        assertEquals(403, fixture.call("DELETE", base + "/exam", null, null, "https://untrusted.example").status());
        assertEquals("in-progress", fixture.get(base + "/exam").body().path("status").asText());
        assertEquals(id, fixture.delete(base + "/exam").body().path("deleted").asText()); assertEquals(200, fixture.delete(base + "/exam").status());
        assertEquals(404, fixture.get(base).status()); assertEquals(404, fixture.get(base + "/questions/q1").status()); assertEquals(404, fixture.post(base + "/exam", Json.object()).status());
        assertEquals(409, fixture.post(bank + "/exams", command).status());
        assertEquals(1, fixture.get(bank + "/exams").body().path("records").size()); assertEquals(practice, fixture.get(bank).body()); assertEquals(history, fixture.get(bank + "/history").body());
        assertEquals("deleted", Json.read(root.resolve(".state/exams/" + id + "/exam.json"), 1024 * 1024).path("status").asText());
        // A canceled attempt no longer needs a readable snapshot to restore its deletion marker.
        Files.delete(root.resolve(".state/exams/" + id + "/snapshot.json")); fixture.server.close(); fixture.server = null; fixture.start(null);
        assertEquals(404, fixture.get(base + "/exam").status()); assertEquals(1, fixture.get(bank + "/exams").body().path("records").size());
        String keptBase = "/api/collections/exam/" + keep;
        assertEquals("in-progress", fixture.get(keptBase + "/exam").body().path("status").asText());
        fixture.post(keptBase + "/exam", Json.object().put("requestId", "delete-completed-handin"));
        assertEquals("EXAM_COMPLETED", fixture.delete(keptBase + "/exam").body().at("/error/code").asText());
        assertEquals(2, fixture.get(bank + "/history").body().path("records").size());
    }

    @Test void deletionFailurePreservesAttemptAndCanceledDeadlinesNeverSubmit() throws Exception {
        setup(false); String id = start(1, "delete-storage-start").path("id").asText(); answer(id, "q1", "yes");
        Path pending = root.resolve(".state/exams/" + id + "/exam.pending"); Files.createDirectory(pending);
        assertEquals("EXAM_SAVE_FAILED", assertThrows(ApiException.class, () -> exams.delete(id, null)).code);
        assertEquals("in-progress", exams.list("bank", "bank").at("/records/0/status").asText());
        assertEquals("yes", states.question(library.collection("exam", id), library.collection("exam", id).question("q1")).at("/state/answer/value").asText());
        Files.delete(pending); exams.delete(id, null); time.now = time.now.plusSeconds(120); exams.tick();
        assertEquals(0, exams.list("bank", "bank").path("records").size()); assertEquals("COLLECTION_NOT_FOUND", assertThrows(ApiException.class, () -> exams.submit(id)).code);
        exams.close(); ai.close(); exams = null; ai = null; setup(false); exams.tick();
        assertEquals(0, exams.list("bank", "bank").path("records").size()); assertEquals(0, exams.appendHistory("bank", "bank", states.history("bank", "bank", null)).path("records").size());
    }

    @Test void temporaryExamDeleteIsSessionScopedAndClearsItsRuntime() throws Exception {
        enable(false); setup(false); var command = Json.object().put("requestId", "delete-memory-start").putNull("durationMinutes");
        String id = exams.start(library.collection("bank", "bank"), command, pageSession).path("id").asText();
        assertEquals(404, assertThrows(ApiException.class, () -> exams.delete(id, java.util.UUID.randomUUID().toString())).status);
        assertEquals(1, exams.list("bank", "bank", pageSession).path("records").size());
        exams.delete(id, pageSession); assertEquals(0, exams.list("bank", "bank", pageSession).path("records").size());
        assertThrows(ApiException.class, () -> library.collection("exam", id)); assertFalse(Files.exists(root.resolve(".state/exams/" + id + "/exam.json")));
    }

    @Test void deletingGradingExamRejectsTheLateAiResponse() throws Exception {
        fixture.write("extensions/generic/rules.js", """
            QF.defineType({project(d,s){return s.submitted?{reveal:d.secret}:{public:d.public};},grade(d,a){return {gradingStatus:'graded',score:0,maxScore:1,correct:false,feedback:null};},getScore(d,s){return {score:s.submitted?s.result.score:0,maxScore:1};},
            prepareAiGrading(d,a){return {protocolVersion:1,question:[{type:'text',text:d.public}],answer:[{type:'text',text:a.value}],referenceAnswer:[{type:'text',text:d.secret}],maxScore:1,scoreStep:1};},
            review(d,a,r){return {gradingStatus:'graded',score:r.score,maxScore:1,correct:r.score===1,feedback:r.feedback};}});
            """);
        automatic = true; responseEntered = new java.util.concurrent.CountDownLatch(1); responseRelease = new java.util.concurrent.CountDownLatch(1); setup(false);
        String id = start(null, "delete-ai-start").path("id").asText(); answer(id, "q1", "yes");
        assertEquals("grading", exams.submit(id).path("status").asText()); assertTrue(responseEntered.await(5, java.util.concurrent.TimeUnit.SECONDS));
        var collection = library.collection("exam", id); var question = collection.question("q1"); String taskId = states.currentAiTaskId(collection, question);
        exams.delete(id, null); responseRelease.countDown();
        long end = System.nanoTime() + java.time.Duration.ofSeconds(5).toNanos();
        while (System.nanoTime() < end && !ai.get(collection, question, taskId).path("status").asText().equals("superseded")) Thread.sleep(20);
        assertEquals("superseded", ai.get(collection, question, taskId).path("status").asText()); assertEquals(0, states.question(collection, question).at("/state/result/score").asInt());
        exams.tick(); assertEquals(0, exams.list("bank", "bank").path("records").size()); assertEquals(0, exams.appendHistory("bank", "bank", states.history("bank", "bank", null)).path("records").size()); assertEquals(1, calls.get());
    }
}

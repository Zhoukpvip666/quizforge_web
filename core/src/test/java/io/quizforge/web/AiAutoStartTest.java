package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

/** Loopback-only model verifies submit scheduling, adoption, finish barriers and receipt replay. */
class AiAutoStartTest {
    @TempDir Path root;
    final ServerTest fixture = new ServerTest();
    final AtomicInteger calls = new AtomicInteger();
    final CountDownLatch firstCall = new CountDownLatch(1), releaseFirst = new CountDownLatch(1);
    HttpServer model;
    static final String COLLECTION = "/api/collections/bank/bank";
    static final String SECOND = COLLECTION + "/questions/q2";

    @BeforeEach void prepare() throws Exception {
        fixture.root = root; fixture.prepare();
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        model.createContext("/v1/chat/completions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            int number = calls.incrementAndGet();
            if (number == 1) {
                firstCall.countDown();
                try { releaseFirst.await(30, TimeUnit.SECONDS); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            }
            ObjectNode answer = Json.object().put("score", 5).put("feedback", "完整回答，获得满分。");
            ObjectNode response = Json.object().put("id", "auto-model-" + number).put("model", "mock-auto-grade");
            response.putArray("choices").addObject().put("finish_reason", "stop").putObject("message").put("content", answer.toString());
            response.putObject("usage").put("total_tokens", 50);
            byte[] bytes = response.toString().getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json"); exchange.sendResponseHeaders(200, bytes.length);
            try { exchange.getResponseBody().write(bytes); } finally { exchange.close(); }
        });
        model.start();
    }

    @AfterEach void close() {
        releaseFirst.countDown(); fixture.close(); if (model != null) model.stop(0);
    }

    void aiRules() throws Exception {
        fixture.write("extensions/generic/rules.js", """
                QF.defineType({
                  project(data,state){return {public:data.public};},
                  grade(){return {gradingStatus:'graded',score:0,maxScore:5,correct:false,feedback:null};},
                  review(data,answer,review){if(!Number.isInteger(review.score*2))throw Error('score step');return {gradingStatus:'graded',score:review.score,maxScore:5,correct:review.score===5,feedback:review.feedback??null};},
                  getScore(data,state){return {score:state.submitted?state.result.score:0,maxScore:5};},
                  prepareAiGrading(data,answer){return {protocolVersion:1,question:[{type:'text',text:data.public}],answer:[{type:'text',text:answer.value}],referenceAnswer:[{type:'text',text:data.secret}],rubric:[{type:'text',text:'Full score 5; half-point increments.'}],maxScore:5,scoreStep:0.5};}
                });
                """);
    }

    void configure(boolean autoGrade) throws Exception {
        ObjectNode profile = Json.object().put("enabled", true).put("autoGrade", autoGrade)
                .put("baseUrl", "http://127.0.0.1:" + model.getAddress().getPort() + "/v1")
                .put("model", "mock-auto-grade").put("apiKey", "fake-auto-grade-key").put("outputMode", "json");
        var saved = fixture.call("PUT", "/api/settings/ai", profile.toString(), null, "http://127.0.0.1:" + fixture.server.port());
        assertEquals(200, saved.status(), saved.body().toString()); assertEquals(autoGrade, saved.body().path("autoGrade").asBoolean());
        assertFalse(saved.body().has("apiKey"));
    }

    JsonNode awaitConfirmed(String questionPath) throws Exception {
        long end = System.nanoTime() + Duration.ofSeconds(20).toNanos(); JsonNode task = null;
        do {
            var reply = fixture.get(questionPath + "/ai/current"); assertEquals(200, reply.status(), reply.body().toString()); task = reply.body().path("task");
            if (task.path("status").asText().equals("confirmed")) return task;
            assertTrue(task.isObject(), "Expected a persisted AI task");
            assertTrue(List.of("queued", "running", "succeeded").contains(task.path("status").asText()), task.toString());
            Thread.sleep(40);
        } while (System.nanoTime() < end);
        fail("AI task did not finish: " + task); return task;
    }

    @Test void optionalSubmitSchedulingAdoptsScoresBlocksEarlyFinishAndNeverRestartsReceiptReplay() throws Exception {
        aiRules(); fixture.start(null); configure(true);
        ObjectNode firstRequest = fixture.action("auto-first-submit", 0, "submit", fixture.answer("yes"));
        var submitted = fixture.post(ServerTest.QUESTION + "/actions", firstRequest);
        assertEquals(200, submitted.status(), submitted.body().toString()); assertTrue(submitted.body().at("/capabilities/canAiGrade").asBoolean());
        assertEquals("graded", submitted.body().at("/state/result/gradingStatus").asText()); assertEquals(0, submitted.body().at("/state/result/score").asDouble());
        assertTrue(firstCall.await(10, TimeUnit.SECONDS), "Submit should start one background model request");
        assertEquals(1, calls.get()); assertEquals(0, fixture.get(ServerTest.QUESTION).body().at("/state/result/score").asDouble());
        JsonNode summary = fixture.get(COLLECTION + "/summary").body();
        ObjectNode finish = Json.object().put("requestId", "auto-early-finish").put("summaryVersion", summary.path("summaryVersion").asText()); finish.set("roundId", summary.path("roundId"));
        var blocked = fixture.post(COLLECTION + "/finish", finish);
        assertEquals(409, blocked.status(), blocked.body().toString()); assertEquals("AI_GRADING_PENDING", blocked.body().at("/error/code").asText());
        releaseFirst.countDown();
        JsonNode firstTask = awaitConfirmed(ServerTest.QUESTION); assertEquals(5, firstTask.at("/candidate/score").asDouble());
        JsonNode graded = fixture.get(ServerTest.QUESTION).body(); assertEquals(5, graded.at("/state/result/score").asDouble()); assertTrue(graded.at("/state/result/correct").asBoolean());
        assertTrue(graded.at("/state/result/feedback").asText().contains("最终得分：5 / 5"));
        var replayed = fixture.post(ServerTest.QUESTION + "/actions", firstRequest);
        assertEquals(200, replayed.status(), replayed.body().toString()); assertEquals(submitted.body(), replayed.body()); assertEquals(1, calls.get());
        assertEquals(firstTask.path("taskId"), fixture.get(ServerTest.QUESTION + "/ai/current").body().at("/task/taskId"));

        configure(false);
        ObjectNode secondRequest = fixture.action("auto-second-submit", 0, "submit", fixture.answer("no"));
        var second = fixture.post(SECOND + "/actions", secondRequest);
        assertEquals(200, second.status(), second.body().toString()); assertTrue(second.body().at("/capabilities/canAiGrade").asBoolean());
        assertEquals(0, second.body().at("/state/result/score").asDouble()); assertTrue(fixture.get(SECOND + "/ai/current").body().path("task").isNull()); assertEquals(1, calls.get());
        configure(true);
        var disabledReplay = fixture.post(SECOND + "/actions", secondRequest);
        assertEquals(200, disabledReplay.status(), disabledReplay.body().toString()); assertEquals(second.body(), disabledReplay.body());
        assertTrue(fixture.get(SECOND + "/ai/current").body().path("task").isNull(), "Enabling later must not retroactively start an old submit receipt"); assertEquals(1, calls.get());
        var manual = fixture.post(SECOND + "/ai/grade", Json.object().put("requestId", "auto-manual-grade").put("contentVersion", second.body().at("/stamp/contentVersion").asText()));
        assertEquals(200, manual.status(), manual.body().toString()); awaitConfirmed(SECOND);
        assertEquals(2, calls.get()); assertEquals(5, fixture.get(SECOND).body().at("/state/result/score").asDouble());
        fixture.finishCurrent("auto-final-finish");
        String historyId = fixture.get(COLLECTION + "/history").body().at("/records/0/id").asText();
        JsonNode history = fixture.get(COLLECTION + "/history/" + historyId).body();
        assertEquals(10, history.at("/summary/score").asDouble()); assertEquals(10, history.at("/summary/maxScore").asDouble());
        assertEquals(5, history.at("/questions/0/payload/state/result/score").asDouble()); assertEquals(5, history.at("/questions/1/payload/state/result/score").asDouble()); assertEquals(2, calls.get());
    }

    @Test void automaticSettingDoesNotCreateAiTasksForOrdinaryUnsupportedQuestions() throws Exception {
        fixture.start(null); configure(true);
        var submitted = fixture.post(ServerTest.QUESTION + "/actions", fixture.action("auto-ordinary-submit", 0, "submit", fixture.answer("yes")));
        assertEquals(200, submitted.status(), submitted.body().toString()); assertFalse(submitted.body().at("/capabilities/canAiGrade").asBoolean());
        assertEquals(1, submitted.body().at("/state/result/score").asDouble()); assertTrue(fixture.get(ServerTest.QUESTION + "/ai/current").body().path("task").isNull());
        assertEquals(0, calls.get()); fixture.finishCurrent("auto-ordinary-finish"); assertEquals(0, calls.get());
    }

    @Test void submitAutomaticallyGradesAllDeclaredChildrenAndReceiptReplayDoesNotScheduleAgain() throws Exception {
        fixture.write("extensions/generic/rules.js", """
                QF.defineType({
                  project(data){return {public:data.public};},
                  grade(){return {gradingStatus:'graded',score:0,maxScore:5,correct:false,feedback:null,parts:{}};},
                  prepareAiGrading(data,answer,context){
                    const input=id=>({protocolVersion:1,question:[{type:'text',text:id}],answer:[{type:'text',text:answer.value}],referenceAnswer:[{type:'text',text:data.secret}],maxScore:2.5,scoreStep:0.5});
                    if(context.automatic)return {targets:['part-1','part-2'].map(id=>({targetId:id,input:input(id)}))};
                    if(!['part-1','part-2'].includes(context.targetId))throw Error('invalid target');
                    return input(context.targetId);
                  },
                  review(data,answer,value,context){const parts={...context.state.result.parts,[value.targetId]:Math.min(value.score,2.5)};const score=Object.values(parts).reduce((a,b)=>a+b,0);return {gradingStatus:'graded',score,maxScore:5,correct:score===5,feedback:value.feedback,parts};},
                  getScore(data,state){return {score:state.submitted?state.result.score:0,maxScore:5};}
                });
                """);
        fixture.start(null); configure(false);
        ObjectNode first = fixture.action("auto-child-disabled", 0, "submit", fixture.answer("yes"));
        var disabled = fixture.post(ServerTest.QUESTION + "/actions", first);
        assertEquals(200, disabled.status()); assertEquals(0, calls.get());
        assertTrue(fixture.get(ServerTest.QUESTION + "/ai/current?targetId=part-1").body().path("task").isNull());
        configure(true);
        var retried = fixture.post(ServerTest.QUESTION + "/actions", fixture.action("auto-child-reanswer", disabled.body().at("/state/revision").asLong(), "retry", Json.object()));
        assertEquals(200, retried.status());
        var submit = fixture.action("auto-child-enabled", retried.body().at("/state/revision").asLong(), "submit", fixture.answer("yes"));
        var submitted = fixture.post(ServerTest.QUESTION + "/actions", submit);
        assertEquals(200, submitted.status(), submitted.body().toString()); assertTrue(firstCall.await(10, TimeUnit.SECONDS));
        assertEquals(0, submitted.body().at("/state/result/score").asDouble());
        JsonNode pending = fixture.get(ServerTest.QUESTION + "/ai/current?targetId=part-2").body().path("task");
        assertEquals("part-2", pending.path("targetId").asText()); assertEquals("queued", pending.path("status").asText());
        JsonNode summary = fixture.get(COLLECTION + "/summary").body();
        ObjectNode finish = Json.object().put("requestId", "auto-child-early-finish").put("summaryVersion", summary.path("summaryVersion").asText()); finish.set("roundId", summary.path("roundId"));
        assertEquals(409, fixture.post(COLLECTION + "/finish", finish).status());
        releaseFirst.countDown();
        for (String id : new String[]{"part-1", "part-2"}) {
            long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(20); JsonNode task;
            do { task = fixture.get(ServerTest.QUESTION + "/ai/current?targetId=" + id).body().path("task");
                if (task.path("status").asText().equals("confirmed")) break;
                assertTrue(List.of("queued", "running", "succeeded").contains(task.path("status").asText()), task.toString()); Thread.sleep(40);
            } while (System.nanoTime() < end);
            assertEquals("confirmed", task.path("status").asText(), task.toString());
        }
        assertEquals(5, fixture.get(ServerTest.QUESTION).body().at("/state/result/score").asDouble());
        assertEquals(2, fixture.get(ServerTest.QUESTION).body().at("/state/result/aiAssessments").size());
        var replay = fixture.post(ServerTest.QUESTION + "/actions", submit);
        assertEquals(submitted.body(), replay.body()); assertEquals(2, calls.get());
        fixture.finishCurrent("auto-child-finish-complete");
        String historyId = fixture.get(COLLECTION + "/history").body().at("/records/0/id").asText();
        JsonNode history = fixture.get(COLLECTION + "/history/" + historyId).body();
        assertEquals(5, history.at("/summary/score").asDouble()); assertEquals(2, history.at("/questions/0/payload/state/result/aiAssessments").size());
    }
}

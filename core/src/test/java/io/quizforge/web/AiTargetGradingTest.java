package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

/** Several model jobs share one submitted answer and atomically merge their own grades. */
class AiTargetGradingTest {
    @TempDir Path root;
    ManualReviewTest fixture;
    AiGradingService service;
    String automaticBaseRules;
    int automaticVersion;
    static final String SECOND = "小题二";

    @BeforeEach void prepare() throws Exception {
        fixture = new ManualReviewTest(); fixture.root = root; fixture.prepare();
        fixture.write("extensions/manual/rules.js", """
                QF.defineType({
                  project(data,state){return {stem:data.stem,maxScore:data.maxScore};},
                  grade(data,answer){return {gradingStatus:'graded',score:0,maxScore:data.maxScore,correct:false,feedback:null,parts:{}};},
                  prepareAiGrading(data,answer,context){
                    const id=context.targetId;
                    if(id!==undefined && !['part-1','小题二'].includes(id))throw Error('unknown target');
                    return {protocolVersion:1,question:[{type:'text',text:id||'whole'}],answer:[{type:'text',text:answer.text}],referenceAnswer:[{type:'text',text:data.reference}],maxScore:id==='part-1'?2:id==='小题二'?3:data.maxScore,scoreStep:0.5};
                  },
                  review(data,answer,value,context){
                    if(!value.targetId)return {gradingStatus:'graded',score:value.score,maxScore:data.maxScore,correct:value.score===data.maxScore,feedback:value.feedback,parts:{}};
                    if(!['part-1','小题二'].includes(value.targetId))throw Error('unknown target');
                    const parts={...context.state.result.parts,[value.targetId]:{score:value.score,feedback:value.feedback}};
                    const score=Object.values(parts).reduce((total,part)=>total+part.score,0);
                    return {gradingStatus:'graded',score,maxScore:data.maxScore,correct:score===data.maxScore,feedback:'combined explanation',parts};
                  },
                  getScore(data,state){return {score:state.submitted?state.result.score:0,maxScore:data.maxScore};}
                });
                """);
        fixture.bank = fixture.library.collection("bank", "manual-bank");
        fixture.save("q1", fixture.act("target-submit-first", "q1", 0, "submit", fixture.answer("submitted answer")));
    }
    @AfterEach void close() { if (service != null) service.close(); }
    ObjectNode command(String id, String target) { ObjectNode request = Json.object().put("requestId", id); if (target != null) request.put("targetId", target); return request; }
    ObjectNode start(String id, String target) { return service.start(fixture.bank, fixture.bank.question("q1"), command(id, target)); }
    ObjectNode get(String id) { return service.get(fixture.bank, fixture.bank.question("q1"), id); }
    ObjectNode await(String id, String expected) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(15); ObjectNode task;
        do { task = get(id); String status = task.path("status").asText(); if (status.equals(expected)) return task;
            if (java.util.List.of("confirmed", "failed", "superseded").contains(status)) fail(task.toString()); Thread.sleep(20);
        } while (System.nanoTime() < end); throw new AssertionError(task.toString());
    }
    AiGateway.Response response(AiGateway.Request request) {
        String target = request.gradingInput().at("/question/0/text").asText();
        assertFalse(request.gradingInput().has("targetId"));
        return new AiGateway.Response(Json.object().put("score", target.equals("part-1")?1.5:target.equals(SECOND)?2:4).put("feedback", "assessment " + target).toString(), "fake", "local", "", null);
    }
    static void waitFor(CountDownLatch latch) {
        try { assertTrue(latch.await(10, TimeUnit.SECONDS)); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AiProviderException("AI_INTERRUPTED", false, 0); }
    }
    void manual(String target, double score, String id) {
        ObjectNode value = fixture.review(score); if (target != null) ((ObjectNode) value.path("review")).put("targetId", target);
        fixture.save("q1", fixture.act(id, "q1", fixture.question("q1").at("/state/revision").asLong(), "review", value));
    }

    void automaticRules(String plan) throws Exception {
        if (automaticBaseRules == null) automaticBaseRules = java.nio.file.Files.readString(root.resolve("extensions/manual/rules.js"));
        String rules = automaticBaseRules;
        rules = rules.replace("const id=context.targetId;", "if(context.automatic === true)return " + plan + "; const id=context.targetId;");
        fixture.write("extensions/manual/rules.js", rules);
        activateAutomaticRules();
    }
    void activateAutomaticRules() throws Exception {
        String version = "1.0." + (++automaticVersion);
        ObjectNode manifest = (ObjectNode) Json.read(root.resolve("extensions/manual/manifest.json"), 256 * 1024);
        manifest.put("version", version); fixture.write("extensions/manual/manifest.json", manifest.toString());
        for (String file : new String[]{"question-banks/manual.json", "extensions/manual/examples.json"}) {
            ObjectNode raw = (ObjectNode) Json.read(root.resolve(file), 8 * 1024 * 1024);
            ((ObjectNode) raw.path("extension")).put("version", version); fixture.write(file, raw.toString());
        }
        fixture.bank = fixture.library.collection("bank", "manual-bank");
        fixture.save("q1", fixture.act("target-auto-resubmit", "q1", fixture.question("q1").at("/state/revision").asLong(), "submit", fixture.answer("submitted answer")));
    }
    static String automaticInput() { return "{protocolVersion:1,question:[{type:'text',text:id}],answer:[{type:'text',text:answer.text}],referenceAnswer:[{type:'text',text:data.reference}],maxScore:2.5,scoreStep:0.5}"; }

    @Test void automaticPlanCreatesIndependentJobsOnceAndMergesTheirScores() throws Exception {
        automaticRules("{targets:['part-1','小题二'].map(id=>({targetId:id,input:" + automaticInput() + "}))}");
        AtomicInteger calls = new AtomicInteger(); CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        service = new AiGradingService(root, fixture.store, fixture.library, request -> {
            if (calls.incrementAndGet() == 1) { entered.countDown(); waitFor(release); }
            return response(request);
        });
        JsonNode tasks;
        try {
            tasks = service.startAutomatic(fixture.bank, fixture.bank.question("q1"), command("automatic-plan-first", null));
            assertEquals(2, tasks.size()); assertTrue(entered.await(10, TimeUnit.SECONDS));
            assertEquals("part-1", tasks.get(0).path("targetId").asText()); assertEquals(SECOND, tasks.get(1).path("targetId").asText());
            assertEquals(tasks.get(1).path("taskId"), service.current(fixture.bank, fixture.bank.question("q1"), SECOND).path("taskId"));
            assertNull(service.current(fixture.bank, fixture.bank.question("q1")));
        } finally { release.countDown(); }
        for (JsonNode task : tasks) await(task.path("taskId").asText(), "confirmed");
        assertEquals(3.5, fixture.question("q1").at("/state/result/score").asDouble());
        JsonNode replay = service.startAutomatic(fixture.bank, fixture.bank.question("q1"), command("automatic-plan-first", null));
        for (int i = 0; i < 2; i++) assertEquals(tasks.get(i).path("taskId"), replay.get(i).path("taskId"));
        assertEquals(2, calls.get());
    }

    @Test void invalidOrEmptyAutomaticPlansNeverPartiallyCallTheProvider() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        service = new AiGradingService(root, fixture.store, fixture.library, request -> { calls.incrementAndGet(); return response(request); });
        for (String plan : new String[]{
                "{targets:['part-1','part-1'].map(id=>({targetId:id,input:" + automaticInput() + "}))}",
                "{targets:['part-1','小题二'].map(id=>({targetId:id,input:id==='part-1'?" + automaticInput() + ":{}}))}",
                "{targets:Array.from({length:257},(_,n)=>({targetId:'part-'+n,input:{}}))}",
                "{targets:[{targetId:' <bad>',input:{}}]}"}) {
            automaticRules(plan);
            ApiException invalid = assertThrows(ApiException.class, () -> service.startAutomatic(fixture.bank, fixture.bank.question("q1"), command("automatic-invalid-plan", null)));
            assertEquals("INVALID_AI_INPUT", invalid.code); assertTrue(fixture.store.currentAiTaskIds(fixture.bank, fixture.bank.question("q1")).isEmpty());
            assertEquals(0, calls.get());
        }
        automaticRules("{targets:[]}");
        assertTrue(service.startAutomatic(fixture.bank, fixture.bank.question("q1"), command("automatic-empty-plan", null)).isEmpty());
        assertEquals(0, calls.get()); assertEquals(0, fixture.question("q1").at("/state/result/score").asDouble());
    }

    @Test void oneCompositeQueuesMoreChildrenThanTheWorkerQueueCapacityWithoutDroppingJobs() throws Exception {
        automaticRules("{targets:Array.from({length:20},(_,n)=>'part-'+n).map(id=>({targetId:id,input:" + automaticInput() + "}))}");
        String rules = java.nio.file.Files.readString(root.resolve("extensions/manual/rules.js"));
        fixture.write("extensions/manual/rules.js", rules.replace("if(!['part-1','小题二'].includes(value.targetId))", "if(!/^part-\\d+$/.test(value.targetId))"));
        activateAutomaticRules();
        AtomicInteger calls = new AtomicInteger(); CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        service = new AiGradingService(root, fixture.store, fixture.library, request -> {
            if (calls.incrementAndGet() == 1) { entered.countDown(); waitFor(release); }
            return new AiGateway.Response("{\"score\":0.1,\"feedback\":\"partial score\"}", "fake", "local", "", null);
        });
        JsonNode tasks;
        try {
            tasks = service.startAutomatic(fixture.bank, fixture.bank.question("q1"), command("automatic-large-plan", null));
            assertTrue(entered.await(10, TimeUnit.SECONDS)); assertEquals(20, tasks.size());
            for (JsonNode task : tasks) assertEquals(task.path("taskId").asText(), fixture.store.currentAiTaskId(fixture.bank, fixture.bank.question("q1"), task.path("targetId").asText()));
        } finally { release.countDown(); }
        for (JsonNode task : tasks) await(task.path("taskId").asText(), "confirmed");
        assertEquals(20, calls.get()); assertEquals(20, fixture.question("q1").at("/state/result/parts").size());
        assertEquals(2, fixture.question("q1").at("/state/result/score").asDouble(), 0.000001);
    }

    @Test void oneFailedAutomaticChildDoesNotStopItsSiblingAndCanRetryIndependently() throws Exception {
        automaticRules("{targets:['part-1','小题二'].map(id=>({targetId:id,input:" + automaticInput() + "}))}");
        AtomicInteger calls = new AtomicInteger();
        service = new AiGradingService(root, fixture.store, fixture.library, request -> {
            if (calls.incrementAndGet() == 1) throw new AiProviderException("AI_CONFIG", false, 0);
            return response(request);
        });
        JsonNode tasks = service.startAutomatic(fixture.bank, fixture.bank.question("q1"), command("automatic-failed-child", null));
        String first = tasks.get(0).path("taskId").asText(), second = tasks.get(1).path("taskId").asText();
        await(first, "failed"); await(second, "confirmed");
        assertEquals(2, calls.get()); assertEquals(2, fixture.question("q1").at("/state/result/score").asDouble());
        JsonNode retried = service.retry(fixture.bank, fixture.bank.question("q1"), first, Json.object().put("requestId", "automatic-child-retry"));
        assertEquals("part-1", retried.path("targetId").asText()); await(retried.path("taskId").asText(), "confirmed");
        assertEquals(3, calls.get()); assertEquals(second, service.current(fixture.bank, fixture.bank.question("q1"), SECOND).path("taskId").asText());
        assertEquals(3.5, fixture.question("q1").at("/state/result/score").asDouble());
    }

    @Test void overlappingTargetsMergeWithoutExpiringEachOtherAndSurviveRestart() throws Exception {
        CountDownLatch firstEntered = new CountDownLatch(1), firstRelease = new CountDownLatch(1), secondEntered = new CountDownLatch(1), secondRelease = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        service = new AiGradingService(root, fixture.store, fixture.library, request -> {
            calls.incrementAndGet(); String target = request.gradingInput().at("/question/0/text").asText();
            if (target.equals("part-1")) { firstEntered.countDown(); waitFor(firstRelease); }
            else { secondEntered.countDown(); waitFor(secondRelease); }
            return response(request);
        });
        String a = start("target-first-request", "part-1").path("taskId").asText(); assertTrue(firstEntered.await(10, TimeUnit.SECONDS));
        String b;
        try {
            b = start("target-second-request", SECOND).path("taskId").asText(); assertNotEquals(a,b);
            assertEquals(a, start("target-first-dedup", "part-1").path("taskId").asText());
            assertEquals(b, start("target-second-dedup", SECOND).path("taskId").asText());
            assertEquals("REQUEST_ID_REUSED",assertThrows(ApiException.class,()->start("target-first-request",SECOND)).code);
            assertNull(service.current(fixture.bank, fixture.bank.question("q1")));
        } finally { firstRelease.countDown(); }
        ObjectNode first;
        try {
            first = await(a, "confirmed"); assertTrue(secondEntered.await(10, TimeUnit.SECONDS));
            assertEquals("part-1", first.path("targetId").asText());
            assertEquals(1.5, fixture.question("q1").at("/state/result/score").asDouble());
            assertEquals(b, fixture.store.currentAiTaskId(fixture.bank, fixture.bank.question("q1"), SECOND));
        } finally { secondRelease.countDown(); }
        await(b, "confirmed"); assertEquals(2,calls.get());
        JsonNode result = fixture.question("q1").at("/state/result");
        assertEquals(3.5,result.path("score").asDouble()); assertEquals(2,result.path("parts").size());
        assertEquals(a,result.at("/aiAssessments/part-1/taskId").asText()); assertEquals(b,result.path("aiAssessments").path(SECOND).path("taskId").asText());
        assertFalse(result.has("aiAssessment")); assertTrue(result.path("feedback").asText().contains("最终得分：3.5 / 5"));
        assertEquals(3.5,fixture.store.summary(fixture.bank).path("score").asDouble());
        String round = fixture.store.summary(fixture.bank).path("roundId").asText();
        assertEquals(3.5,fixture.store.history("bank",fixture.bank.id(),round).at("/questions/0/payload/state/result/score").asDouble());
        assertEquals(3.5,service.confirm(fixture.bank,fixture.bank.question("q1"),a,Json.object().put("requestId","target-ack-first").put("candidateVersion",first.at("/candidate/version").asText())).at("/payload/state/result/score").asDouble());
        service.close(); fixture.store = new StateStore(root,fixture.engine);
        service = new AiGradingService(root,fixture.store,fixture.library,request -> { fail("Restart must not call provider"); return null; });
        assertEquals(a,service.current(fixture.bank,fixture.bank.question("q1"),"part-1").path("taskId").asText());
        assertEquals(b,service.current(fixture.bank,fixture.bank.question("q1"),SECOND).path("taskId").asText());
        assertEquals(3.5,fixture.question("q1").at("/state/result/score").asDouble());
    }

    @Test void replacingOneTargetAndRetryingItPreservesItsSibling() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1); AtomicInteger calls = new AtomicInteger();
        service = new AiGradingService(root,fixture.store,fixture.library,request -> { if(calls.incrementAndGet()==1){entered.countDown();waitFor(release);} return response(request); });
        String old = start("target-old-first", "part-1").path("taskId").asText(); assertTrue(entered.await(10,TimeUnit.SECONDS));
        String sibling, replacement;
        try {
            sibling = start("target-sibling-queued",SECOND).path("taskId").asText();
            replacement = service.start(fixture.bank,fixture.bank.question("q1"),command("target-force-first","part-1").put("force",true)).path("taskId").asText();
        } finally {release.countDown();}
        await(sibling,"confirmed"); await(replacement,"confirmed"); assertEquals("superseded",get(old).path("status").asText());
        ObjectNode retried = service.retry(fixture.bank,fixture.bank.question("q1"),replacement,Json.object().put("requestId","target-retry-first"));
        assertEquals("part-1",retried.path("targetId").asText()); await(retried.path("taskId").asText(),"confirmed");
        assertEquals(sibling,service.current(fixture.bank,fixture.bank.question("q1"),SECOND).path("taskId").asText());
        assertEquals(3.5,fixture.question("q1").at("/state/result/score").asDouble()); assertEquals(4,calls.get());
    }

    @Test void manualTargetReviewExpiresOnlyThatTarget() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1); AtomicInteger calls = new AtomicInteger();
        service = new AiGradingService(root,fixture.store,fixture.library,request -> { if(calls.incrementAndGet()==1){entered.countDown();waitFor(release);} return response(request); });
        String a = start("target-before-manual","part-1").path("taskId").asText(); assertTrue(entered.await(10,TimeUnit.SECONDS));
        String b;
        try { b = start("target-other-during-manual",SECOND).path("taskId").asText(); manual("part-1",1,"target-manual-first"); }
        finally { release.countDown(); }
        await(b,"confirmed"); assertEquals("superseded",get(a).path("status").asText());
        assertEquals(3,fixture.question("q1").at("/state/result/score").asDouble());
        assertEquals(1,fixture.question("q1").at("/state/result/parts/part-1/score").asDouble());
    }

    @Test void wholeReviewAndAnswerResetExpireEveryChildJob() throws Exception {
        for(boolean reset : new boolean[]{false,true}) {
            CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
            service = new AiGradingService(root,fixture.store,fixture.library,request -> { entered.countDown();waitFor(release);return response(request); });
            String a = start("target-expire-a-"+reset,"part-1").path("taskId").asText(); assertTrue(entered.await(10,TimeUnit.SECONDS)); String b;
            try {
                b=start("target-expire-b-"+reset,SECOND).path("taskId").asText();
                if(reset) fixture.save("q1",fixture.act("target-answer-reset","q1",fixture.question("q1").at("/state/revision").asLong(),"retry",Json.object()));
                else manual(null,4,"target-whole-manual");
            } finally {release.countDown();}
            await(a,"superseded"); await(b,"superseded"); assertTrue(fixture.store.currentAiTaskIds(fixture.bank,fixture.bank.question("q1")).isEmpty());
            service.close();
        }
        assertEquals("unanswered",fixture.question("q1").at("/state/status").asText());
    }

    @Test void wholeAndChildTasksCannotOverwriteEachOther() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1); AtomicInteger calls = new AtomicInteger();
        service = new AiGradingService(root,fixture.store,fixture.library,request -> {if(calls.incrementAndGet()==1){entered.countDown();waitFor(release);}return response(request);});
        String whole=start("target-whole-old",null).path("taskId").asText(); assertTrue(entered.await(10,TimeUnit.SECONDS)); String child;
        try {child=start("target-child-new","part-1").path("taskId").asText();} finally {release.countDown();}
        await(child,"confirmed"); assertEquals("superseded",get(whole).path("status").asText());
        assertEquals(1.5,fixture.question("q1").at("/state/result/score").asDouble());
        String next=start("target-whole-new",null).path("taskId").asText(); await(next,"confirmed");
        assertEquals(4,fixture.question("q1").at("/state/result/score").asDouble());
        assertNull(service.current(fixture.bank,fixture.bank.question("q1"),"part-1"));
    }

    @Test void invalidOrUnknownTargetsAreRejectedBeforeAnyModelCall() throws Exception {
        AtomicInteger calls=new AtomicInteger(); service=new AiGradingService(root,fixture.store,fixture.library,request->{calls.incrementAndGet();return response(request);});
        for(String target:new String[]{""," leading","<b>","x".repeat(129)}) assertThrows(ApiException.class,()->start("target-invalid-"+calls.get(),target));
        assertThrows(ApiException.class,()->service.start(fixture.bank,fixture.bank.question("q1"),Json.object().put("requestId","target-null-id").putNull("targetId")));
        assertEquals("RULE_REJECTED",assertThrows(ApiException.class,()->start("target-unknown-part","part-999")).code); assertEquals(0,calls.get());
    }
}

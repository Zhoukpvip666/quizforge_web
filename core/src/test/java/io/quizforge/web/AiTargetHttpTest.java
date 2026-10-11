package io.quizforge.web;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class AiTargetHttpTest {
    @TempDir Path root;
    @Test void childQueriesFinishGuardAndSavedHistoryUseTheSameScopedTasks() throws Exception {
        ServerTest fixture = new ServerTest(); fixture.root=root; fixture.prepare();
        fixture.write("extensions/generic/rules.js", """
                QF.defineType({
                  project(data,state){return {public:data.public};},
                  grade(){return {gradingStatus:'graded',score:0,maxScore:5,correct:false,feedback:null,parts:{}};},
                  prepareAiGrading(data,answer,context){
                    if(!['part-1','小题二'].includes(context.targetId))throw Error('invalid target');
                    return {protocolVersion:1,question:[{type:'text',text:context.targetId}],answer:[{type:'text',text:answer.value}],referenceAnswer:[{type:'text',text:data.secret}],maxScore:2.5,scoreStep:0.5};
                  },
                  review(data,answer,value,context){const parts={...context.state.result.parts,[value.targetId]:value.score};const score=Object.values(parts).reduce((a,b)=>a+b,0);return {gradingStatus:'graded',score,maxScore:5,correct:score===5,feedback:value.feedback,parts};},
                  getScore(data,state){return {score:state.submitted?state.result.score:0,maxScore:5};}
                });
                """);
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1); AtomicInteger calls=new AtomicInteger();
        HttpServer model=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        model.createContext("/v1/chat/completions",exchange->{
            Json.MAPPER.readTree(exchange.getRequestBody());
            if(calls.incrementAndGet()==1){entered.countDown();try{assertTrue(release.await(10,TimeUnit.SECONDS));}catch(InterruptedException error){Thread.currentThread().interrupt();}}
            var body=Json.object(); body.putArray("choices").addObject().put("finish_reason","stop").putObject("message").put("content","{\"score\":2,\"feedback\":\"synthetic grade\"}");
            byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(200,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();
        }); model.start();
        try {
            fixture.start(null);
            var settings=Json.object().put("enabled",true).put("baseUrl","http://127.0.0.1:"+model.getAddress().getPort()+"/v1").put("model","synthetic-target-test");
            assertEquals(200,fixture.call("PUT","/api/settings/ai",settings.toString(),null,"http://127.0.0.1:"+fixture.server.port()).status());
            assertEquals(200,fixture.post(ServerTest.QUESTION+"/actions",fixture.action("target-http-submit",0,"submit",fixture.answer("yes"))).status());
            var a=fixture.post(ServerTest.QUESTION+"/ai/grade",Json.object().put("requestId","target-http-first").put("targetId","part-1"));
            assertEquals(200,a.status(),a.body().toString());assertTrue(entered.await(10,TimeUnit.SECONDS));
            var b=fixture.post(ServerTest.QUESTION+"/ai/grade",Json.object().put("requestId","target-http-second").put("targetId","小题二"));
            assertEquals(200,b.status(),b.body().toString());
            assertTrue(fixture.get(ServerTest.QUESTION+"/ai/current").body().path("task").isNull());
            assertEquals(a.body().path("taskId"),fixture.get(ServerTest.QUESTION+"/ai/current?targetId=part-1").body().at("/task/taskId"));
            assertEquals(b.body().path("taskId"),fixture.get(ServerTest.QUESTION+"/ai/current?targetId="+java.net.URLEncoder.encode("小题二",StandardCharsets.UTF_8)).body().at("/task/taskId"));
            assertEquals(400,fixture.get(ServerTest.QUESTION+"/ai/current?targetId=").status());
            assertEquals(400,fixture.get(ServerTest.QUESTION+"/ai/current?targetId=part-1&targetId=part-2").status());
            var summary=fixture.get("/api/collections/bank/bank/summary").body();var finish=Json.object().put("requestId","target-http-finish");finish.set("roundId",summary.path("roundId"));finish.set("summaryVersion",summary.path("summaryVersion"));
            var pending=fixture.post("/api/collections/bank/bank/finish",finish);assertEquals(409,pending.status());assertEquals("AI_GRADING_PENDING",pending.body().at("/error/code").asText());
            release.countDown();
            for(var started:new ServerTest.Reply[]{a,b}){
                String path=ServerTest.QUESTION+"/ai/tasks/"+started.body().path("taskId").asText();long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);var task=fixture.get(path).body();
                while(java.util.List.of("queued","running","succeeded").contains(task.path("status").asText())&&System.nanoTime()<end){Thread.sleep(30);task=fixture.get(path).body();}
                assertEquals("confirmed",task.path("status").asText(),task.toString());assertEquals(started.body().path("targetId"),task.path("targetId"));
            }
            assertEquals(4,fixture.get(ServerTest.QUESTION).body().at("/state/result/score").asDouble());
            fixture.finishCurrent("target-http-finish-complete");
            var history=fixture.get("/api/collections/bank/bank/history").body();String round=history.path("records").get(0).path("id").asText();
            var snapshot=fixture.get("/api/collections/bank/bank/history/"+round).body();
            assertEquals(4,snapshot.at("/summary/score").asDouble());assertEquals(2,snapshot.at("/questions/0/payload/state/result/aiAssessments").size());assertEquals(2,calls.get());
        } finally {release.countDown();fixture.close();model.stop(0);}
    }
}

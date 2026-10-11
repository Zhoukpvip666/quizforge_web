package io.quizforge.web;

import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

class LibraryIndexHttpTest {
    @TempDir Path root;
    CatalogRuleValidationTest trace;
    ServerTest fixture;
    @BeforeEach void setup() throws Exception { trace = new CatalogRuleValidationTest(); trace.root = root; trace.prepare(); fixture = trace.fixture; }
    @AfterEach void close() { trace.close(); }
    @Test void coldIndexIsPendingAndRunsNoRulesWhileCatalogRemainsComplete() throws Exception {
        fixture.start(null); ServerTest.Reply result = fixture.get("/api/library/index");
        assertEquals(200,result.status()); assertEquals("pending",result.body().at("/banks/0/validationStatus").asText()); assertTrue(result.body().path("canManage").asBoolean());
        assertEquals(0,trace.validations.get()); assertFalse(result.body().at("/banks/0").has("contentRevision"));
        ServerTest.Reply full = fixture.get("/api/catalog"); assertEquals(200,full.status()); assertTrue(full.body().at("/banks/0").has("contentRevision"));
        assertEquals(2,trace.validations.get());
    }
    @Test void indexRequiresSameAuthenticationAsOtherReadEndpoints() throws Exception {
        fixture.start(ServerTest.TOKEN);
        assertEquals(401,fixture.call("GET","/api/library/index",null,null,null).status());
        assertEquals(200,fixture.call("GET","/api/library/index",null,ServerTest.TOKEN,null).status());
    }
    @Test void checkedRowsReturnToPendingAfterSourceChangesAndDeletedRowsDisappear() throws Exception {
        fixture.start(null); fixture.get("/api/library/index");
        assertEquals(200, fixture.get("/api/collections/bank/bank").status());
        assertEquals("ready", fixture.get("/api/library/index").body().at("/banks/0/validationStatus").asText());
        fixture.write("question-banks/bank.json", trace.bank().put("title", "Changed").toString());
        assertEquals("pending", fixture.get("/api/library/index").body().at("/banks/0/validationStatus").asText());
        java.nio.file.Files.delete(root.resolve("question-banks/bank.json"));
        assertEquals(0, fixture.get("/api/library/index").body().path("banks").size());
    }
    @Test void indexAndForegroundCollectionDoNotWaitForLibraryMonitor() throws Exception {
        fixture.start(null); var field = QuizForgeServer.class.getDeclaredField("library"); field.setAccessible(true); Object library = field.get(fixture.server);
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        CompletableFuture<Void> holder = CompletableFuture.runAsync(() -> { synchronized(library) { started.countDown(); try { release.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } } });
        try {
            assertTrue(started.await(2,TimeUnit.SECONDS));
            var index = CompletableFuture.supplyAsync(() -> { try { return fixture.get("/api/library/index"); } catch(Exception e) { throw new CompletionException(e); } });
            assertEquals(200,index.get(3,TimeUnit.SECONDS).status()); assertFalse(holder.isDone());
            var foreground = CompletableFuture.supplyAsync(() -> { try { return fixture.get("/api/collections/bank/bank"); } catch(Exception e) { throw new CompletionException(e); } });
            assertEquals(200,foreground.get(5,TimeUnit.SECONDS).status()); assertFalse(holder.isDone());
        } finally { release.countDown(); holder.get(3,TimeUnit.SECONDS); }
    }
    @Test void sourceChangedDuringRealRuleExecutionCannotPublishOldReady() throws Exception {
        CountDownLatch started=new CountDownLatch(1),release=new CountDownLatch(1);
        trace.trace.removeContext("/"); trace.trace.createContext("/",exchange->{
            if(exchange.getRequestURI().getPath().equals("/validateBank")) {started.countDown();try{release.await(5,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}}
            exchange.sendResponseHeaders(204,-1);exchange.close();
        });
        fixture.start(null);fixture.get("/api/library/index");
        var opening=CompletableFuture.supplyAsync(()->{try{return fixture.get("/api/collections/bank/bank");}catch(Exception e){throw new CompletionException(e);}});
        try {
            assertTrue(started.await(3,TimeUnit.SECONDS));
            fixture.write("question-banks/bank.json",trace.bank().put("title","Updated during validation").toString());
            release.countDown();assertEquals(409,opening.get(8,TimeUnit.SECONDS).status());
            var index=fixture.get("/api/library/index").body();assertEquals("Updated during validation",index.at("/banks/0/title").asText());assertNotEquals("ready",index.at("/banks/0/validationStatus").asText());
        } finally {release.countDown();}
    }
    @Test void pollingResumesBackgroundChecksAfterDeepSourceChange() throws Exception {
        fixture.start(null);fixture.get("/api/library/index");assertEquals(200,fixture.get("/api/collections/bank/bank").status());
        awaitReady(); var libraryField=QuizForgeServer.class.getDeclaredField("library");libraryField.setAccessible(true);var library=libraryField.get(fixture.server);var threadField=Library.class.getDeclaredField("backgroundThread");threadField.setAccessible(true);Thread background=(Thread)threadField.get(library);if(background!=null){background.join(15000);assertFalse(background.isAlive());}
        int calls=trace.validations.get(); Path rules=root.resolve("extensions/generic/rules.js"); java.nio.file.Files.writeString(rules,java.nio.file.Files.readString(rules)+"\n// changed after background completed\n");
        assertNotEquals("ready",fixture.get("/api/library/index").body().at("/banks/0/validationStatus").asText());
        awaitReady(); assertTrue(trace.validations.get()>calls,"Polling should resume the completed background dispatcher");
    }
    void awaitReady() throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(30);
        do { var index=fixture.get("/api/library/index").body(); boolean complete=true;
            for(String section:java.util.List.of("banks","extensions"))for(var row:index.path(section))if(java.util.List.of("pending","checking").contains(row.path("validationStatus").asText()))complete=false;
            if(complete)return;Thread.sleep(50);
        }while(System.nanoTime()<end);fail("Background validation did not finish");
    }
}

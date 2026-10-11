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
}

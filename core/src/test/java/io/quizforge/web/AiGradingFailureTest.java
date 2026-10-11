package io.quizforge.web;

import com.fasterxml.jackson.databind.node.DecimalNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.jupiter.api.Assertions.*;

/** All provider calls and persistence failures use synthetic temporary fixtures. */
class AiGradingFailureTest {
    @TempDir Path root;
    AiGradingServiceTest fixture;
    @BeforeEach void prepare() throws Exception { fixture = new AiGradingServiceTest(); fixture.root = root; fixture.prepare(); }
    @AfterEach void close() { fixture.close(); }

    @Test void candidatePersistenceFailureRetainsItsNamedCodeAndSubmittedAnswer() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        fixture.service = new AiGradingService(root, fixture.fixture.store, fixture.fixture.library, request -> {
            entered.countDown();
            try { if (!release.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Synthetic provider was not released"); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AiProviderException("AI_INTERRUPTED", false, 0); }
            return fixture.valid();
        });
        ObjectNode before = fixture.fixture.question("q1").deepCopy();
        String id = fixture.start("ai-write-failure-test").path("taskId").asText();
        assertTrue(entered.await(10, TimeUnit.SECONDS));
        Path taskFile = root.resolve(".state/ai-grading/" + id + ".json");
        byte[] original = Files.readAllBytes(taskFile); AtomicBoolean injected = new AtomicBoolean();
        // Inject at candidate finalization, after the response-attempt write. A numeric
        // node avoids production-only test hooks and remains unchanged when serialized.
        var liveField = AiGradingService.class.getDeclaredField("live"); liveField.setAccessible(true);
        Object task = ((Map<?, ?>) liveField.get(fixture.service)).get(id); assertNotNull(task);
        var valueField = task.getClass().getDeclaredField("value"); valueField.setAccessible(true);
        synchronized (task) {
            ObjectNode value = (ObjectNode) valueField.get(task);
            ((ObjectNode) value.at("/snapshot/gradingInput")).set("maxScore", new DecimalNode(BigDecimal.valueOf(5)) {
                @Override public BigDecimal decimalValue() {
                    if (injected.compareAndSet(false, true)) try { Files.delete(taskFile); Files.createDirectory(taskFile); }
                    catch (java.io.IOException error) { throw new IllegalStateException("Synthetic failure injection could not be prepared"); }
                    return super.decimalValue();
                }
            });
        }
        try {
            release.countDown(); ObjectNode failed = awaitFailedSnapshot(task, valueField);
            assertTrue(injected.get()); assertTrue(failed.path("candidate").isObject());
            assertEquals("AI_TASK_WRITE_FAILED", failed.at("/error/code").asText());
            assertEquals("评分任务保存失败，当前作答仍保留。", failed.at("/error/message").asText());
            assertEquals(1, failed.path("calls").asInt());
            assertEquals(before.path("state"), fixture.fixture.question("q1").path("state"));
            assertEquals(1, fixture.fixture.store.summary(fixture.fixture.bank).path("pendingCount").asInt());
        } finally {
            release.countDown(); fixture.service.close();
            if (Files.isDirectory(taskFile)) Files.delete(taskFile);
            Files.write(taskFile, original);
        }
    }

    @Test void unexpectedFailureLogsOnlyClassAndApplicationLocations() throws Exception {
        String secret = "synthetic-private-provider-output-never-log";
        PrintStream previous = System.err; ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (PrintStream captured = new PrintStream(output, true, StandardCharsets.UTF_8)) {
            System.setErr(captured);
            fixture.service = new AiGradingService(root, fixture.fixture.store, fixture.fixture.library, request -> { throw new IllegalStateException(secret); });
            ObjectNode failed = awaitFailed(fixture.start("ai-safe-diagnostic-test").path("taskId").asText());
            assertEquals("AI_TASK_FAILED", failed.at("/error/code").asText());
            assertFalse(failed.toString().contains(secret));
        } finally { System.setErr(previous); }
        String logged = output.toString(StandardCharsets.UTF_8);
        assertTrue(logged.contains("java.lang.IllegalStateException"));
        assertTrue(logged.contains("io.quizforge.web.AiGradingService.execute"));
        assertFalse(logged.contains(secret)); assertFalse(logged.contains("java.util.concurrent"));
    }

    private ObjectNode awaitFailed(String id) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15); ObjectNode task;
        do { task = fixture.get(id); if (task.path("status").asText().equals("failed")) return task; Thread.sleep(20); } while (System.nanoTime() < deadline);
        fail("Synthetic AI task did not fail"); return null;
    }

    private ObjectNode awaitFailedSnapshot(Object task, java.lang.reflect.Field valueField) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        do {
            // Observe the worker without get(), which can itself apply a candidate.
            synchronized (task) { ObjectNode value = (ObjectNode) valueField.get(task); if (value.path("status").asText().equals("failed")) return value.deepCopy(); }
            Thread.sleep(20);
        } while (System.nanoTime() < deadline);
        fail("Synthetic AI worker did not fail"); return null;
    }
}

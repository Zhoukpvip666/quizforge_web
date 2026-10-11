package io.quizforge.web;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayInputStream;
import java.nio.file.Path;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class AiModelDiagnosticsTest {
    @TempDir Path root;
    AiSettings settings;
    AiModelDiagnostics.Challenge image;
    @BeforeEach void prepare() throws Exception {
        settings = new AiSettings(root);
        settings.update(Json.object().put("baseUrl", "https://example.test/v1").put("model", "test-model").put("apiKey", "synthetic-test-key"));
        image = AiModelDiagnostics.challenge();
    }
    AiGateway.Response response(double score, String feedback) {
        return new AiGateway.Response(Json.object().put("score", score).put("feedback", feedback).toString(), "fake", "test-model", "fake-response", Json.object());
    }
    String check(ObjectNode report, int index) { return report.at("/checks/" + index + "/status").asText(); }
    @Test void detectsRealImageContentPersistsReportAndDoesNotRevealExpectedAnswerInText() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        ObjectNode report = new AiModelDiagnostics(settings, (profile, content) -> {
            assertEquals("json", profile.outputMode()); assertTrue(profile.timeoutSeconds() <= 35);
            int index = calls.incrementAndGet();
            if (index == 1) return response(2.5, "format works");
            assertEquals("image_url", content.get(1).path("type").asText());
            assertFalse(content.get(0).path("text").asText().contains(image.expected()));
            assertEquals(image.dataUrl(), content.get(1).at("/image_url/url").asText());
            return response(0, image.expected());
        }, () -> image).run();
        assertEquals(2, calls.get()); assertTrue(report.path("ok").asBoolean()); assertEquals("passed", report.path("status").asText());
        assertEquals("passed", check(report, 2)); assertTrue(settings.profile().vision()); assertFalse(settings.profile().enabled());
        assertFalse(report.toString().contains("synthetic-test-key")); assertFalse(report.toString().contains(image.expected()));
        AiSettings reopened = new AiSettings(root); assertTrue(reopened.profile().vision()); assertEquals("passed", reopened.status().at("/testReport/status").asText());
        var png = ImageIO.read(new ByteArrayInputStream(Base64.getDecoder().decode(image.dataUrl().substring(image.dataUrl().indexOf(',') + 1))));
        assertEquals(520, png.getWidth()); assertEquals(150, png.getHeight());
    }
    @Test void rejectedJsonOptionFallsBackToTextAndSavesItsMode() {
        AtomicInteger calls = new AtomicInteger();
        ObjectNode report = new AiModelDiagnostics(settings, (profile, content) -> {
            int call = calls.incrementAndGet();
            if (call == 1) { assertEquals("json", profile.outputMode()); throw new AiProviderException("AI_CONFIG", false, 0); }
            assertEquals("text", profile.outputMode()); return call == 2 ? response(2.5, "works") : response(0, image.expected());
        }, () -> image).run();
        assertEquals(3, calls.get()); assertEquals("passed", report.path("status").asText()); assertEquals("text", settings.profile().outputMode());
    }
    @Test void aSuccessfulHttpReplyCannotPassVisionWithoutRecognizingTheImage() {
        AtomicInteger calls = new AtomicInteger();
        ObjectNode report = new AiModelDiagnostics(settings, (profile, content) -> calls.incrementAndGet() == 1 ? response(2.5, "works") : response(0, "guessed-content"), () -> image).run();
        assertTrue(report.path("ok").asBoolean()); assertEquals("partial", report.path("status").asText()); assertEquals("failed", check(report, 2)); assertFalse(settings.profile().vision());
    }
    @Test void authenticationAndVisionTransportFailuresRemainDistinctFromUnsupportedVision() {
        AtomicInteger calls = new AtomicInteger();
        ObjectNode failed = new AiModelDiagnostics(settings, (profile, content) -> { calls.incrementAndGet(); throw new AiProviderException("AI_AUTH", false, 0); }, () -> image).run();
        assertEquals(1, calls.get()); assertEquals("failed", check(failed, 0)); assertEquals("skipped", check(failed, 2));
        calls.set(0);
        ObjectNode unknown = new AiModelDiagnostics(settings, (profile, content) -> { if (calls.incrementAndGet() == 1) return response(2.5, "works"); throw new AiProviderException("AI_TIMEOUT", true, 0); }, () -> image).run();
        assertEquals("unknown", check(unknown, 2)); assertEquals("partial", unknown.path("status").asText()); assertFalse(settings.profile().vision());
    }
    @Test void malformedGradingOutputIsReportedAndDoesNotTriggerAnImageCall() {
        AtomicInteger calls = new AtomicInteger();
        ObjectNode report = new AiModelDiagnostics(settings, (profile, content) -> { calls.incrementAndGet(); return response(4.2, "wrong score"); }, () -> image).run();
        assertEquals(1, calls.get()); assertEquals("passed", check(report, 0)); assertEquals("failed", check(report, 1)); assertEquals("skipped", check(report, 2));
    }
    @Test void staleTestCannotOverwriteANewModelAndOrdinaryToggleChangesKeepReport() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        AiModelDiagnostics diagnostics = new AiModelDiagnostics(settings, (profile, content) -> {
            if (calls.incrementAndGet() == 1) return response(2.5, "works");
            try { settings.update(Json.object().put("model", "new-model")); } catch (Exception error) { throw new RuntimeException(error); }
            return response(0, image.expected());
        }, () -> image);
        assertEquals("AI_CONFIG_CHANGED", assertThrows(ApiException.class, diagnostics::run).code);
        assertEquals("new-model", settings.profile().model()); assertTrue(settings.status().path("testReport").isNull());
        calls.set(0);
        new AiModelDiagnostics(settings, (profile, content) -> calls.incrementAndGet() == 1 ? response(2.5, "works") : response(0, image.expected()), () -> image).run();
        settings.update(Json.object().put("autoGrade", true)); assertTrue(settings.profile().vision()); assertTrue(settings.status().path("testReport").isObject());
        settings.update(Json.object().put("apiKey", "changed-test-key")); assertFalse(settings.profile().vision()); assertTrue(settings.status().path("testReport").isNull());
    }
}

package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.awt.Color;
import java.awt.Font;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.function.Supplier;
import javax.imageio.ImageIO;

/** Explicit, bounded diagnostics using synthetic material only; never returns model text or credentials. */
final class AiModelDiagnostics {
    @FunctionalInterface interface Probe { AiGateway.Response call(AiSettings.Profile profile, ArrayNode content); }
    record Challenge(String expected, String dataUrl) { }
    private final AiSettings settings;
    private final Probe probe;
    private final Supplier<Challenge> challenges;
    AiModelDiagnostics(AiSettings settings, Probe probe) { this(settings, probe, AiModelDiagnostics::challenge); }
    AiModelDiagnostics(AiSettings settings, Probe probe, Supplier<Challenge> challenges) { this.settings = settings; this.probe = probe; this.challenges = challenges; }

    ObjectNode run() {
        AiSettings.Profile original = settings.profile();
        if (original.baseUrl() == null || original.model().isBlank()) throw new AiProviderException("AI_NOT_CONFIGURED", false, 0);
        long started = System.nanoTime(); int calls = 0;
        String mode = "json";
        ObjectNode report = Json.object().put("testedAt", Instant.now().toString()).put("model", original.model());
        ArrayNode checks = report.putArray("checks");
        ObjectNode connection = check(checks, "connection", "文字连接"), format = check(checks, "gradingFormat", "评分输出"), vision = check(checks, "vision", "图片识别");
        AiGateway.Response text = null; AiProviderException failure = null;
        ArrayNode content = Json.MAPPER.createArrayNode(); content.add(Json.object().put("type", "text").put("text", "这是显式模型测试，不包含用户题库或答案。maxScore=5，scoreStep=0.5。请仅返回 JSON：{\"score\":2.5,\"feedback\":\"文字与评分输出正常\"}。"));
        try { calls++; text = probe.call(profile(original, mode), content); }
        catch (AiProviderException error) {
            // A rejected JSON option may be an otherwise usable text-compatible model.
            if (error.code.equals("AI_CONFIG")) {
                mode = "text";
                try { calls++; text = probe.call(profile(original, mode), content); }
                catch (AiProviderException second) { failure = second; }
            } else failure = error;
        }
        if (failure != null || text == null) {
            mark(connection, "failed", failure == null ? "模型未返回可用响应。" : failure.getMessage());
            mark(format, "skipped", "连接未通过，暂未验证评分输出。"); mark(vision, "skipped", "连接未通过，暂时无法判断图片能力。");
        } else {
            mark(connection, "passed", "模型已成功返回文字响应。");
            JsonNode output = output(text);
            boolean formatOk = output != null && output.path("score").decimalValue().compareTo(java.math.BigDecimal.valueOf(2.5)) == 0;
            mark(format, formatOk ? "passed" : "failed", formatOk ? "返回了符合要求的分数与反馈。" : "模型已响应，但评分结果格式或测试分数不符合要求。");
            if (formatOk) {
                Challenge image = challenges.get(); ArrayNode imageContent = Json.MAPPER.createArrayNode();
                imageContent.add(Json.object().put("type", "text").put("text", "这是图片识别测试。请读取图片中唯一一行大写字母与数字，保持原顺序和大小写。仅返回 JSON：score 固定为 0，feedback 只填写读出的字符，不添加解释。正确字符仅存在于图片中。"));
                imageContent.add(Json.object().put("type", "image_url").set("image_url", Json.object().put("url", image.dataUrl()).put("detail", "auto")));
                try {
                    calls++; JsonNode visualOutput = output(probe.call(profile(original, mode), imageContent));
                    boolean recognized = visualOutput != null && visualOutput.path("score").decimalValue().signum() == 0 && image.expected().equals(visualOutput.path("feedback").asText().strip());
                    mark(vision, recognized ? "passed" : "failed", recognized ? "成功读出随机测试图片，可用于图片评分。" : "未能正确读出测试图片，图片评分暂未启用。");
                } catch (AiProviderException error) { mark(vision, "unknown", "图片测试未完成：" + error.getMessage()); }
            } else mark(vision, "skipped", "评分输出未通过，暂未验证图片能力。");
        }
        boolean usable = connection.path("status").asText().equals("passed") && format.path("status").asText().equals("passed");
        boolean supportsVision = vision.path("status").asText().equals("passed");
        report.put("ok", usable).put("status", !usable ? "failed" : supportsVision ? "passed" : "partial")
                .put("summary", !usable ? "模型测试未通过，请查看下方结果。" : supportsVision ? "文字评分与基础图片识别均通过。" : "文字评分可用，图片识别尚未通过。")
                .put("calls", calls).put("elapsedMs", (System.nanoTime() - started) / 1_000_000)
                .put("note", "图片通过仅代表基础识别测试成功，复杂图表及手写内容仍需实际验证。");
        try { report.set("settings", settings.saveTest(original, report, supportsVision, mode)); }
        catch (IOException error) { throw new ApiException(503, "AI_TEST_SAVE_FAILED", "测试结果未能保存，请重试；已有配置保留。"); }
        return report;
    }
    private static ObjectNode check(ArrayNode checks, String id, String label) { return checks.addObject().put("id", id).put("label", label); }
    private static void mark(ObjectNode check, String status, String message) { check.put("status", status).put("message", message); }
    private static AiSettings.Profile profile(AiSettings.Profile source, String mode) {
        return new AiSettings.Profile(source.enabled(), source.baseUrl(), source.model(), source.apiKey(), true, mode, 2048, Math.min(35, source.timeoutSeconds()), source.autoGrade());
    }
    private static JsonNode output(AiGateway.Response response) {
        if (response == null || response.output() == null || response.output().length() > 24000) return null;
        String text = response.output().strip();
        if (text.startsWith("```")) {
            int newline = text.indexOf('\n');
            if (newline < 0 || !text.endsWith("```")) return null;
            String tag = text.substring(3, newline).strip(); if (!tag.isEmpty() && !tag.equalsIgnoreCase("json")) return null;
            text = text.substring(newline + 1, text.length() - 3).strip();
        }
        try {
            JsonNode output = Json.MAPPER.readTree(text);
            if (output == null || !output.isObject() || output.size() != 2 || !output.path("score").isNumber() || !Double.isFinite(output.path("score").asDouble())
                    || !output.path("feedback").isTextual() || output.path("feedback").asText().isBlank() || output.path("feedback").asText().length() > 18000) return null;
            return output;
        } catch (IOException error) { return null; }
    }
    static Challenge challenge() {
        String alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; SecureRandom random = new SecureRandom(); StringBuilder expected = new StringBuilder();
        for (int i = 0; i < 6; i++) expected.append(alphabet.charAt(random.nextInt(alphabet.length())));
        BufferedImage image = new BufferedImage(520, 150, BufferedImage.TYPE_INT_RGB); var graphics = image.createGraphics();
        try {
            graphics.setColor(Color.WHITE); graphics.fillRect(0, 0, image.getWidth(), image.getHeight());
            graphics.setColor(Color.BLACK); graphics.setFont(new Font(Font.MONOSPACED, Font.BOLD, 72));
            graphics.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
            graphics.drawString(expected.toString(), 95, 100);
        } finally { graphics.dispose(); }
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); ImageIO.write(image, "png", bytes);
            return new Challenge(expected.toString(), "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes.toByteArray()));
        } catch (IOException error) { throw new ApiException(500, "AI_TEST_IMAGE_FAILED", "无法生成图片测试，请重试。"); }
    }
}

package io.quizforge.web;

import java.nio.file.Path;

final class InstalledExtensionFixtures {
    private InstalledExtensionFixtures() { }
    static Path find(String id, String version) throws Exception {
        Path fixture = switch (id + "@" + version) {
            case "quizforge.single-choice@1.0.0" -> Path.of("test/fixtures/legacy-extensions/single-choice-1.0.0");
            case "quizforge.short-answer@1.3.0" -> Path.of("test/fixtures/legacy-extensions/short-answer-1.3.0");
            default -> null;
        };
        if (fixture != null) {
            var manifest = Json.read(fixture.resolve("manifest.json"), 256 * 1024);
            if (!manifest.path("id").asText().equals(id) || !manifest.path("version").asText().equals(version)) {
                throw new java.io.IOException("Released test fixture identity mismatch: " + id + "@" + version);
            }
            return fixture;
        }
        for (Path directory : ExtensionDirectories.scan(Path.of("../extensions"))) {
            if (DevelopmentExtensions.marked(directory)) continue;
            try {
                var manifest = Json.read(directory.resolve("manifest.json"), 256 * 1024);
                if (manifest.path("id").asText().equals(id) && manifest.path("version").asText().equals(version)) return directory;
            } catch (java.io.IOException ignored) { }
        }
        throw new java.io.IOException("Installed test source unavailable: " + id + "@" + version);
    }
}

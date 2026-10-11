package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import static org.junit.jupiter.api.Assertions.*;

class LibraryIndexTest {
    @TempDir Path root;
    void write(String path, String value) throws Exception {
        Path file = root.resolve(path); Files.createDirectories(file.getParent()); Files.writeString(file, value);
    }
    void fixture() throws Exception {
        write("extensions/generic/manifest.json", """
            {"id":"generic","version":"1.0.0","name":"Generic","entry":"missing.html","script":"missing.js","style":"missing.css","rules":"bad.js","questionSchema":"missing.schema.json","answerSchema":"missing.answer.json","examples":"examples.json"}
            """);
        write("extensions/generic/bad.js", "throw new Error('rules must not execute while listing');");
        write("extensions/generic/examples.json", bank("examples"));
        write("question-banks/bank.json", bank("bank"));
        write("question-banks/assets/invalid.png", "not an image: must not be imported while listing");
    }
    String bank(String id) { return "{\"id\":\"" + id + "\",\"title\":\"Bank title\",\"extension\":{\"id\":\"generic\",\"version\":\"1.0.0\"},\"questions\":[{\"id\":\"q1\",\"title\":\"Question\",\"data\":{}}]}"; }
    Object scan(DevelopmentSettings settings) throws Exception {
        Class<?> type = Class.forName("io.quizforge.web.LibraryIndex");
        Object index = type.getDeclaredConstructor(Path.class, DevelopmentSettings.class).newInstance(root, settings);
        return type.getDeclaredMethod("scan").invoke(index);
    }
    ObjectNode catalog(Object snapshot) throws Exception { return (ObjectNode) snapshot.getClass().getDeclaredMethod("catalog").invoke(snapshot); }
    String revision(Object snapshot) throws Exception { return (String) snapshot.getClass().getDeclaredMethod("revision").invoke(snapshot); }
    JsonNode row(JsonNode catalog, String id) { for (JsonNode row : catalog.path("banks")) if (row.path("id").asText().equals(id)) return row; throw new AssertionError("Bank missing"); }
    @Test void lightweightScanDoesNotLoadPagesRulesOrImages() throws Exception {
        fixture(); Object snapshot = assertDoesNotThrow(() -> scan(new DevelopmentSettings(root)));
        JsonNode value = row(catalog(snapshot), "bank");
        assertEquals("pending", value.path("validationStatus").asText());
        assertEquals(1, value.path("questionCount").asInt()); assertFalse(value.has("error")); assertFalse(value.has("contentRevision"));
        assertFalse(Files.exists(root.resolve(".state/resources")));
        assertEquals("pending", catalog(snapshot).path("extensions").get(0).path("validationStatus").asText());
    }
    @Test void badMetadataDoesNotHideGoodBankAndChangesInvalidateRevision() throws Exception {
        fixture(); write("question-banks/broken.json", "{broken"); DevelopmentSettings settings = new DevelopmentSettings(root);
        Object first = assertDoesNotThrow(() -> scan(settings));
        assertEquals("error", row(catalog(first), "broken").path("validationStatus").asText());
        assertFalse(row(catalog(first), "bank").has("error"));
        assertEquals(revision(first), revision(assertDoesNotThrow(() -> scan(settings))));
        write("question-banks/bank.json", bank("bank").replace("Bank title", "Changed title"));
        Object next = assertDoesNotThrow(() -> scan(settings));
        assertNotEquals(revision(first), revision(next)); assertEquals("Changed title", row(catalog(next), "bank").path("title").asText());
    }
    @Test void developmentModeControlsRowsAndEmptyGroupsSurvive() throws Exception {
        fixture(); write("extensions/dev/development.json", "{\"name\":\"Prototype\",\"entry\":\"missing.html\"}");
        write("question-banks/dev-bank.json", "{\"id\":\"dev-bank\",\"title\":\"Dev\",\"extension\":{\"development\":\"dev\"},\"questions\":[{\"id\":\"q1\",\"title\":\"Question\",\"data\":{}}]}");
        Files.createDirectories(root.resolve("question-banks/Empty")); DevelopmentSettings settings = new DevelopmentSettings(root);
        Object before = assertDoesNotThrow(() -> scan(settings)); assertEquals(1, catalog(before).path("banks").size());
        assertTrue(java.util.stream.StreamSupport.stream(catalog(before).at("/groups/banks").spliterator(), false).anyMatch(group -> group.asText().equals("Empty")));
        settings.update(Json.object().put("enabled", true)); Object after = assertDoesNotThrow(() -> scan(settings));
        assertNotEquals(revision(before), revision(after)); assertEquals("development-bank", row(catalog(after), "dev-bank").path("kind").asText());
        assertFalse(row(catalog(after), "dev-bank").has("error"));
    }
    @Test void latestFormalVersionDoesNotHideMixedBankBindings() throws Exception {
        fixture(); String manifest = Files.readString(root.resolve("extensions/generic/manifest.json"));
        write("extensions/newer/manifest.json", manifest.replace("1.0.0", "1.1.0"));
        ObjectNode raw = (ObjectNode) Json.MAPPER.readTree(bank("bank"));
        ObjectNode second = raw.withArray("questions").addObject().put("id", "q2").put("title", "New version");
        second.set("data", Json.object()); second.set("extension", Json.object().put("id", "generic").put("version", "1.1.0"));
        write("question-banks/bank.json", raw.toString());
        Object snapshot = assertDoesNotThrow(() -> scan(new DevelopmentSettings(root)));
        assertEquals("1.1.0", catalog(snapshot).path("extensions").get(0).path("version").asText());
        assertEquals(2, row(catalog(snapshot), "bank").path("extensions").size()); assertFalse(row(catalog(snapshot), "bank").has("error"));
    }
    @Test void unsafeExamplePathIsRejectedEvenWhenTargetDoesNotExist() throws Exception {
        fixture(); String manifest = Files.readString(root.resolve("extensions/generic/manifest.json"));
        write("extensions/generic/manifest.json", manifest.replace("\"examples.json\"", "\"../outside.json\""));
        Object snapshot = assertDoesNotThrow(() -> scan(new DevelopmentSettings(root)));
        assertEquals("error", catalog(snapshot).path("extensions").get(0).path("validationStatus").asText());
    }
}

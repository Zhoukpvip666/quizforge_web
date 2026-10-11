package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.lang.reflect.InvocationTargetException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class CollectionValidationTest {
    @TempDir Path root;
    ServerTest fixture;
    RuleEngine engine;
    @BeforeEach void setup() throws Exception {
        fixture = new ServerTest(); fixture.root = root; fixture.prepare();
        engine = new RuleEngine(root, "node", Duration.ofSeconds(8));
    }
    @AfterEach void close() { fixture.close(); }
    ObjectNode bank() throws Exception { return (ObjectNode) Json.read(root.resolve("question-banks/bank.json"), 8 * 1024 * 1024); }
    Library.Extension extension() {
        Path dir = root.resolve("extensions/generic");
        return new Library.Extension("generic", "1.0.0", "Generic", "", dir, dir.resolve("page.html"), dir.resolve("page.js"), dir.resolve("page.css"), dir.resolve("rules.js"), dir.resolve("question.json"), dir.resolve("answer.json"), dir.resolve("examples.json"), "fixture");
    }
    // Reflect until extraction exists, so RED reports a failed behavior assertion rather than a compilation error.
    Object prepare(JsonNode raw, String kind, Library.Extension owner) throws Throwable {
        try {
            Class<?> type = Class.forName("io.quizforge.web.CollectionValidation");
            Object validator = type.getDeclaredConstructor(RuleEngine.class).newInstance(engine);
            return type.getDeclaredMethod("prepare", JsonNode.class, String.class, Library.Extension.class, String.class, Map.class)
                    .invoke(validator, raw, kind, owner, "bank", Map.of(owner.id() + "@" + owner.version(), owner));
        } catch (InvocationTargetException error) { throw error.getCause(); }
    }
    Object finish(Object prepared) throws Throwable {
        try {
            Class<?> type = Class.forName("io.quizforge.web.CollectionValidation");
            Object validator = type.getDeclaredConstructor(RuleEngine.class).newInstance(engine);
            return type.getDeclaredMethod("finish", prepared.getClass(), Class.forName(type.getName() + "$Check"), boolean.class, RuntimeException.class)
                    .invoke(validator, prepared, null, false, null);
        } catch (InvocationTargetException error) { throw error.getCause(); }
    }
    Library.Collection collection(Object result) throws Exception { return (Library.Collection) result.getClass().getDeclaredMethod("collection").invoke(result); }
    @Test void validDataIsCopiedAndExplicitOutlineIsPreserved() throws Exception {
        ObjectNode raw = bank(); ((ObjectNode) raw.at("/questions/0")).putObject("outline").put("level", "question").put("label", "First label");
        Object prepared = assertDoesNotThrow(() -> prepare(raw, "bank", extension()));
        ((ObjectNode) raw.at("/questions/0/data")).put("public", "changed after prepare");
        Library.Collection result = collection(assertDoesNotThrow(() -> finish(prepared)));
        assertEquals("visible", result.question("q1").data().path("public").asText());
        assertEquals("First label", result.question("q1").outline().label());
    }
    @Test void duplicateIdsAreRejectedBeforeRules() throws Exception {
        ObjectNode raw = bank(); ((ObjectNode) raw.at("/questions/1")).put("id", "q1");
        ApiException error = assertThrows(ApiException.class, () -> prepare(raw, "bank", extension()));
        assertEquals(400, error.status);
    }
    @Test void formalSchemaFailureIsNotAccepted() throws Exception {
        ObjectNode raw = bank(); ((ObjectNode) raw.at("/questions/0/data")).put("public", 13);
        Object prepared = assertDoesNotThrow(() -> prepare(raw, "bank", extension()));
        assertEquals("RULE_REJECTED", assertThrows(ApiException.class, () -> finish(prepared)).code);
    }
    @Test void developmentToleranceDoesNotBecomeSuccessfulCheck() throws Exception {
        fixture.write("extensions/generic/development.json", "{}");
        Library.Extension runtime = DevelopmentExtensions.runtime(extension(), "generic", "fixture");
        ObjectNode raw = bank(); raw.set("extension", Json.object().put("id", runtime.id()).put("version", runtime.version()));
        ((ObjectNode) raw.at("/questions/0/data")).put("public", 13);
        Object prepared = assertDoesNotThrow(() -> prepare(raw, "development", runtime));
        Object result = assertDoesNotThrow(() -> finish(prepared));
        assertEquals(2, collection(result).questions().size());
        assertNull(result.getClass().getDeclaredMethod("successfulCheck").invoke(result));
    }
    @Test void sameQuestionIdKeepsEachCollectionsOwnOutline() throws Exception {
        ObjectNode first = bank(), second = bank();
        ((ObjectNode) first.at("/questions/0")).putObject("outline").put("level", "question").put("label", "A");
        ((ObjectNode) second.at("/questions/0")).putObject("outline").put("level", "question").put("label", "B");
        Object a = assertDoesNotThrow(() -> prepare(first, "bank", extension())), b = assertDoesNotThrow(() -> prepare(second, "bank", extension()));
        assertEquals("A", collection(assertDoesNotThrow(() -> finish(a))).question("q1").outline().label());
        assertEquals("B", collection(assertDoesNotThrow(() -> finish(b))).question("q1").outline().label());
    }
}

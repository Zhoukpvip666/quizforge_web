package io.quizforge.web;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.time.Duration;
import static org.junit.jupiter.api.Assertions.*;

class ScopedLibraryLoaderTest {
    @TempDir Path root;
    CatalogRuleValidationTest trace;
    Library library;
    @BeforeEach void setup() throws Exception {
        trace = new CatalogRuleValidationTest(); trace.root = root; trace.prepare();
        library = new Library(root, new RuleEngine(root, "node", Duration.ofSeconds(8)));
    }
    @AfterEach void close() { trace.close(); }
    void unrelatedBadBank() throws Exception {
        ObjectNode bad = trace.bank().put("id", "unrelated"); ((ObjectNode) bad.at("/questions/0/data")).put("public", 13);
        trace.bankFile("unrelated", bad);
    }
    @Test void openingBankDoesNotValidateUnrelatedBank() throws Exception {
        unrelatedBadBank(); assertEquals(2, library.collection("bank", "bank").questions().size());
        assertEquals(2, trace.validations.get()); assertEquals(2, trace.largestBatch.get());
    }
    @Test void pageOnlyLoadsItsExtensionExamples() throws Exception {
        unrelatedBadBank(); assertTrue(library.page("generic", "1.0.0").path("html").asText().contains("Example"));
        assertEquals(1, trace.validations.get());
    }
    @Test void unchangedTargetIsReusedAndChangedRulesAreRevalidated() throws Exception {
        unrelatedBadBank(); library.collection("bank", "bank"); int count = trace.validations.get();
        library.collection("bank", "bank"); assertEquals(count, trace.validations.get());
        Path rules = root.resolve("extensions/generic/rules.js"); trace.fixture.write("extensions/generic/rules.js", Files.readString(rules) + "\n// new bytes\n");
        library.collection("bank", "bank"); assertEquals(count + 2, trace.validations.get());
    }
    @Test void invalidEarlierDuplicateDoesNotHideGoodCandidate() throws Exception {
        ObjectNode bad = trace.bank(); ((ObjectNode) bad.at("/questions/0/data")).put("public", 13); trace.bankFile("0-first", bad);
        assertEquals("visible", library.collection("bank", "bank").question("q1").data().path("public").asText());
    }
    @Test void developmentDescriptorDoesNotScanOtherDevelopmentBanks() throws Exception {
        trace.fixture.write("extensions/generic/development.json", "{}"); new DevelopmentSettings(root).update(Json.object().put("enabled", true));
        ObjectNode bank = trace.bank(); bank.set("extension", Json.object().put("development", "generic")); trace.bankFile("bank", bank);
        ObjectNode bad = bank.deepCopy().put("id", "unrelated"); ((ObjectNode) bad.at("/questions/0/data")).put("public", 13); trace.bankFile("unrelated", bad);
        library = new Library(root, new RuleEngine(root, "node", Duration.ofSeconds(8)));
        assertEquals("development-bank", library.developmentBank("bank").path("kind").asText());
        assertEquals(2, trace.validations.get()); assertEquals(2, trace.largestBatch.get());
    }
    @Test void invalidKindIsRejectedAsInvalidRequest() {
        assertEquals(400, assertThrows(ApiException.class, () -> library.collection("unknown-kind", "unknown-id")).status);
    }
}

package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

/** Count actual synthetic rule processes through a loopback-only trace endpoint. */
class CatalogRuleValidationTest {
    @TempDir Path root;
    ServerTest fixture;
    HttpServer trace;
    Library library;
    final AtomicInteger validations = new AtomicInteger(), outlines = new AtomicInteger(), largestBatch = new AtomicInteger(), largestBytes = new AtomicInteger();

    @BeforeEach void prepare() throws Exception {
        fixture = new ServerTest(); fixture.root = root; fixture.prepare();
        trace = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        trace.createContext("/", exchange -> {
            String operation = exchange.getRequestURI().getPath();
            if (operation.equals("/validateBank")) validations.incrementAndGet();
            if (operation.equals("/outlineBatch")) outlines.incrementAndGet();
            for (String field : exchange.getRequestURI().getRawQuery().split("&")) {
                String[] pair = field.split("="); int value = Integer.parseInt(pair[1]);
                if (pair[0].equals("items")) largestBatch.accumulateAndGet(value, Math::max);
                if (pair[0].equals("bytes")) largestBytes.accumulateAndGet(value, Math::max);
            }
            exchange.sendResponseHeaders(204, -1); exchange.close();
        }); trace.start();
        Path runner = root.resolve("server/rules-runner.cjs"); String source = Files.readString(runner);
        String signal = """
                const request = JSON.parse(input);
                // Synthetic test trace; no filesystem writes or production endpoints.
                const trace = require('node:http').request({host:'127.0.0.1',port:PORT,agent:false,path:'/'+request.op+'?items='+(request.questions?.length||0)+'&bytes='+Buffer.byteLength(JSON.stringify(request.questions||[]))}, response => {response.resume();response.on('end',()=>trace.destroy());}); trace.end();
                """.replace("PORT", Integer.toString(trace.getAddress().getPort()));
        fixture.write("server/rules-runner.cjs", source.replace("const request = JSON.parse(input);", signal));
    }
    @AfterEach void close() { if (trace != null) trace.stop(0); if (fixture != null) fixture.close(); }
    void setup() throws Exception { library = new Library(root, new RuleEngine(root, "node", Duration.ofSeconds(8))); }
    ObjectNode bank() throws Exception { return (ObjectNode) Json.read(root.resolve("question-banks/bank.json"), 8 * 1024 * 1024); }
    void bankFile(String file, ObjectNode bank) throws Exception { fixture.write("question-banks/" + file + ".json", bank.toString()); }
    ObjectNode row(JsonNode catalog, String id) { for (JsonNode row : catalog.path("banks")) if (row.path("id").asText().equals(id)) return (ObjectNode) row; throw new AssertionError("Synthetic bank is missing"); }
    void valid(JsonNode catalog) { for (String section : new String[]{"banks", "extensions"}) for (JsonNode row : catalog.path(section)) assertFalse(row.has("error"), row.toString()); }

    @Test void coldCatalogSharesProcessesAndWarmAndChangedContentKeepExistingCacheSemantics() throws Exception {
        bankFile("second", bank().put("id", "second")); setup(); ObjectNode first = library.catalog(); valid(first);
        assertEquals(2, validations.get()); // One preview, one merged bank phase instead of two bank processes.
        assertEquals(4, largestBatch.get()); valid(library.catalog()); assertEquals(2, validations.get());
        ObjectNode changed = bank().put("title", "Renamed bank"); bankFile("bank", changed);
        assertEquals("Renamed bank", row(library.catalog(), "bank").path("title").asText()); assertEquals(3, validations.get());
        Path rules = root.resolve("extensions/generic/rules.js"); fixture.write("extensions/generic/rules.js", Files.readString(rules) + "\n// changed package bytes\n");
        valid(library.catalog()); assertEquals(5, validations.get());
    }

    @Test void rejectedMergedBankIsIsolatedAndARepairedBankIsValidatedAgain() throws Exception {
        ObjectNode original = bank(); bankFile("good", original.deepCopy().put("id", "good"));
        ObjectNode invalid = original.deepCopy(); ((ObjectNode) invalid.at("/questions/0/data")).put("public", 13); bankFile("bank", invalid);
        setup(); ObjectNode rejected = library.catalog(); assertEquals("RULE_REJECTED", row(rejected, "bank").path("errorCode").asText());
        assertFalse(row(rejected, "good").has("error")); assertEquals(2, library.collection("bank", "good").questions().size());
        assertEquals(404, assertThrows(ApiException.class, () -> library.collection("bank", "bank")).status);
        assertEquals(4, validations.get()); // Preview, merged failure, and two individual fallback checks.
        bankFile("bank", original); valid(library.catalog()); assertEquals(5, validations.get());
    }

    @Test void duplicateQuestionIdsKeepOutlineResultsInsideTheirOriginalCollections() throws Exception {
        ObjectNode manifest = (ObjectNode) Json.read(root.resolve("extensions/generic/manifest.json"), 1024 * 1024);
        manifest.putObject("requiresApi").put("major", 1).put("minMinor", 1).putArray("capabilities").add("outline-items");
        fixture.write("extensions/generic/manifest.json", manifest.toString());
        Path rules = root.resolve("extensions/generic/rules.js"); fixture.write("extensions/generic/rules.js", Files.readString(rules).replace("QF.defineType({", "QF.defineType({getOutlineItems(data){return [{id:'part',label:data.public}];},"));
        ObjectNode second = bank().put("id", "second"); ((ObjectNode) second.at("/questions/0/data")).put("public", "Second bank child"); bankFile("second", second);
        setup(); valid(library.catalog()); assertEquals(2, validations.get()); assertEquals(3, outlines.get());
        assertEquals("visible", library.collection("bank", "bank").question("q1").outlineItems().getFirst().label());
        assertEquals("Second bank child", library.collection("bank", "second").question("q1").outlineItems().getFirst().label());
    }

    @Test void anInvalidEarlierDuplicateDoesNotClaimTheLaterBanksId() throws Exception {
        ObjectNode original = bank(); Files.delete(root.resolve("question-banks/bank.json"));
        ObjectNode invalid = original.deepCopy().put("title", "Invalid first"); ((ObjectNode) invalid.at("/questions/0/data")).put("public", 13);
        bankFile("a-invalid", invalid); bankFile("z-valid", original.put("title", "Valid survivor"));
        setup(); ObjectNode catalog = library.catalog(); assertTrue(catalog.at("/banks/0").has("error")); assertFalse(catalog.at("/banks/1").has("error"));
        assertEquals("Valid survivor", library.collection("bank", "bank").title());
    }

    @Test void statefulValidatorsKeepOriginalCollectionAndWithinChunkBoundaries() throws Exception {
        Path rules = root.resolve("extensions/generic/rules.js");
        fixture.write("extensions/generic/rules.js", "let count=0;\n" + Files.readString(rules).replace("validateQuestion(data){return data.public.length > 0;}", "validateQuestion(data){return ++count>1 || data.public!=='reject-first';}"));
        ObjectNode original = bank(), rejected = original.deepCopy().put("id", "reject");
        ObjectNode question = ((ObjectNode) rejected.path("questions").get(0)).deepCopy(); ((ObjectNode) question.path("data")).put("public", "reject-first");
        rejected.putArray("questions").add(question); bankFile("reject", rejected);
        ObjectNode shared = original.deepCopy().put("id", "shared"); ((ObjectNode) shared.at("/questions/1/data")).put("public", "reject-first"); bankFile("shared", shared);
        setup(); ObjectNode catalog = library.catalog();
        assertEquals("RULE_REJECTED", row(catalog, "reject").path("errorCode").asText());
        assertFalse(row(catalog, "bank").has("error")); assertFalse(row(catalog, "shared").has("error"));
        assertEquals(2, library.collection("bank", "shared").questions().size());
    }

    @Test void mergedQuestionsRetainTheExisting512ItemChunkBound() throws Exception {
        ObjectNode source = bank(); Files.delete(root.resolve("question-banks/bank.json"));
        for (int bankIndex = 0; bankIndex < 3; bankIndex++) {
            ObjectNode value = source.deepCopy().put("id", "bank" + bankIndex); var questions = value.putArray("questions");
            for (int index = 0; index < 200; index++) questions.add(((ObjectNode) source.path("questions").get(0)).deepCopy().put("id", "q" + index));
            bankFile("bank" + bankIndex, value);
        }
        setup(); valid(library.catalog()); assertEquals(3, validations.get()); assertTrue(largestBatch.get() <= 512);
    }

    @Test void mergedQuestionsRetainTheExisting512KiBChunkTarget() throws Exception {
        ObjectNode source = bank(); source.putArray("questions").add(bank().path("questions").get(0).deepCopy());
        ((ObjectNode) source.at("/questions/0/data")).put("public", "x".repeat(320_000));
        bankFile("bank", source); bankFile("second", source.deepCopy().put("id", "second"));
        setup(); valid(library.catalog()); assertEquals(3, validations.get()); assertTrue(largestBytes.get() <= 512 * 1024);
    }
}

package io.quizforge.web;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class RuleEngineConcurrencyTest {
    @TempDir Path temporary;

    @Test void pipeTasksDoNotStarveTheStdinWriterWithTwoCommonPoolWorkers() throws Exception {
        String executable = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        String classpath = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        Process process = new ProcessBuilder(executable, "-Djava.util.concurrent.ForkJoinPool.common.parallelism=2",
                "-Djdk.virtualThreadScheduler.parallelism=2", "-Djdk.virtualThreadScheduler.maxPoolSize=2",
                "-cp", classpath, LowParallelismProbe.class.getName(), Path.of("").toAbsolutePath().toString(), temporary.toString())
                .redirectErrorStream(true).start();
        try {
            assertTrue(process.waitFor(20, TimeUnit.SECONDS), "Isolated rule probe did not finish");
            String output = new String(process.getInputStream().readNBytes(65537), java.nio.charset.StandardCharsets.UTF_8);
            assertEquals(0, process.exitValue(), output);
            assertTrue(output.contains("VALIDATE_OK_AFTER_TIMEOUT"), output);
        } finally { if (process.isAlive()) process.destroyForcibly(); }
    }

    public static class LowParallelismProbe {
        public static void main(String[] arguments) throws Exception {
            if (ForkJoinPool.getCommonPoolParallelism() != 2) throw new IllegalStateException("Probe must use two common-pool workers");
            Path core = Path.of(arguments[0]), temporary = Path.of(arguments[1]);
            Files.writeString(temporary.resolve("rules.js"), "QF.defineType({project(data){return data;},grade(){return {score:1,maxScore:1,correct:true,feedback:''};}});");
            Files.writeString(temporary.resolve("question.json"), "true"); Files.writeString(temporary.resolve("answer.json"), "true");
            var extension = new Library.Extension("probe", "1.0.0", "Probe", "", temporary, null, null, null,
                    temporary.resolve("rules.js"), temporary.resolve("question.json"), temporary.resolve("answer.json"), null, "probe");
            RuleEngine engine = new RuleEngine(core, "node", Duration.ofSeconds(3));
            validate(engine, extension);

            Path stalledCore = temporary.resolve("stalled-core"); Files.createDirectories(stalledCore.resolve("server"));
            Files.writeString(stalledCore.resolve("server/rules-runner.cjs"), "process.stdin.resume();setInterval(()=>{},1000);");
            RuleEngine stalled = new RuleEngine(stalledCore, "node", Duration.ofMillis(400));
            try { validate(stalled, extension); throw new IllegalStateException("Stalled runner must time out"); }
            catch (ApiException error) { if (!error.code.equals("RULE_TIMEOUT")) throw error; }
            validate(engine, extension);
            System.out.println("VALIDATE_OK_AFTER_TIMEOUT");
        }
        private static void validate(RuleEngine engine, Library.Extension extension) {
            var request = Json.object().put("op", "validateBank"); request.putArray("questions");
            if (!engine.run(extension, request).path("valid").asBoolean()) throw new IllegalStateException("Rule validation failed");
        }
    }
}

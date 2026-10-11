package io.quizforge.web;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.*;
import java.time.Duration;
import static org.junit.jupiter.api.Assertions.*;

class ValidationCacheTest {
    @TempDir Path root;
    String key(String text) { return ResourceStore.hash(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
    Object cache() throws Exception { return Class.forName("io.quizforge.web.ValidationCache").getDeclaredConstructor(Path.class).newInstance(root); }
    void write(Object cache, String key, CollectionValidation.Check check) throws Exception { cache.getClass().getDeclaredMethod("write",String.class,CollectionValidation.Check.class).invoke(cache,key,check); }
    Optional<?> read(Object cache,String key,int count) throws Exception { return (Optional<?>)cache.getClass().getDeclaredMethod("read",String.class,int.class).invoke(cache,key,count); }
    CollectionValidation.Check check() { return new CollectionValidation.Check(List.of(List.of(new Library.OutlineItem("part","Part 1")))); }
    Path directory() { return root.resolve(".state/validation-cache/v1"); }
    @Test void successfulRecordSurvivesRestartAndWrongQuestionCountIsIgnored() throws Exception {
        Object cache=assertDoesNotThrow(this::cache); write(cache,key("success"),check());
        assertEquals(check(), read(cache(),key("success"),1).orElseThrow()); assertTrue(read(cache,key("success"),2).isEmpty());
    }
    @Test void corruptOversizedAndInvalidOutlinesAreIgnored() throws Exception {
        Object cache=assertDoesNotThrow(this::cache); write(cache,key("bad"),check()); Path file=directory().resolve(key("bad")+".json");
        Files.writeString(file,"{broken"); assertTrue(read(cache,key("bad"),1).isEmpty());
        write(cache,key("bad"),check()); String valid=Files.readString(file); Files.writeString(file,valid.replace("Part 1","<unsafe>")); assertTrue(read(cache,key("bad"),1).isEmpty());
        Files.write(file,new byte[2*1024*1024+1]); assertTrue(read(cache,key("bad"),1).isEmpty());
        assertTrue(read(cache,"../outside",1).isEmpty());
    }
    @Test void unwritableCachePathAndSymlinkAreOptionalRatherThanLoadFailures() throws Exception {
        Object cache=assertDoesNotThrow(this::cache); Files.createDirectories(root.resolve(".state")); Files.writeString(root.resolve(".state/validation-cache"),"ordinary file");
        assertDoesNotThrow(()->write(cache,key("a"),check())); assertTrue(read(cache,key("a"),1).isEmpty());
    }
    @Test void concurrentWritesRemainReadableAndEntryAndByteLimitsAreEnforced() throws Exception {
        Object cache=assertDoesNotThrow(this::cache);
        try(var executor=java.util.concurrent.Executors.newFixedThreadPool(4)) {
            var futures=new ArrayList<java.util.concurrent.Future<?>>(); for(int i=0;i<12;i++) futures.add(executor.submit(()->{try {write(cache,key("shared"),check());} catch(Exception e){throw new RuntimeException(e);}}));
            for(var future:futures) future.get();
        }
        assertEquals(check(),read(cache(),key("shared"),1).orElseThrow());
        for(int i=0;i<2050;i++) Files.writeString(directory().resolve(key("entry"+i)+".json"),"{}");
        write(cache,key("last"),check()); try(var files=Files.list(directory())) { assertTrue(files.filter(p->p.toString().endsWith(".json")).count()<=2048); }
        byte[] large=new byte[1024*1024]; for(int i=0;i<35;i++) Files.write(directory().resolve(key("large"+i)+".json"),large);
        write(cache,key("trim"),check()); try(var files=Files.list(directory())) { assertTrue(files.mapToLong(p->{try{return Files.size(p);}catch(Exception e){throw new RuntimeException(e);}}).sum()<=32L*1024*1024); }
    }
    @Test void restartReusesRulesButChangedRuleAndSchemaBytesCannotReuseSuccess() throws Exception {
        CatalogRuleValidationTest trace=new CatalogRuleValidationTest(); trace.root=root; trace.prepare();
        try {
            new Library(root,new RuleEngine(root,"node",Duration.ofSeconds(8))).collection("bank","bank"); int count=trace.validations.get(); assertEquals(2,count);
            new Library(root,new RuleEngine(root,"node",Duration.ofSeconds(8))).collection("bank","bank"); assertEquals(count,trace.validations.get());
            Path rules=root.resolve("extensions/generic/rules.js"); Files.writeString(rules,Files.readString(rules)+"\n// changed\n");
            new Library(root,new RuleEngine(root,"node",Duration.ofSeconds(8))).collection("bank","bank"); assertEquals(count+2,trace.validations.get());
            Path schema=root.resolve("extensions/generic/question.json"); Files.writeString(schema,Files.readString(schema)+" ");
            new Library(root,new RuleEngine(root,"node",Duration.ofSeconds(8))).collection("bank","bank"); assertEquals(count+4,trace.validations.get());
        } finally {trace.close();}
    }
    @Test void actualDependencyBytesChangeEnvironmentEvenWhenVersionSizeAndMtimeDoNot() throws Exception {
        CatalogRuleValidationTest trace=new CatalogRuleValidationTest(); trace.root=root; trace.prepare();
        try {
            RuleEngine engine=new RuleEngine(root,"node",Duration.ofSeconds(8)); var method=RuleEngine.class.getDeclaredMethod("validationEnvironment"); String before=(String)method.invoke(engine);
            Path dependency=root.resolve("node_modules/ajv/dist/ajv.js"); var time=Files.getLastModifiedTime(dependency); byte[] bytes=Files.readAllBytes(dependency); bytes[bytes.length-1]=bytes[bytes.length-1]==' '? (byte)'\n':(byte)' '; Files.write(dependency,bytes); Files.setLastModifiedTime(dependency,time);
            assertNotEquals(before,method.invoke(engine));
        } finally {trace.close();}
    }
    @Test void ruleTimeoutNeverProducesSuccessRecords() throws Exception {
        CatalogRuleValidationTest trace=new CatalogRuleValidationTest();trace.root=root;trace.prepare();
        try {
            Files.writeString(root.resolve("server/rules-runner.cjs"),"process.stdin.resume();setInterval(()=>{},1000);");
            Library library=new Library(root,new RuleEngine(root,"node",Duration.ofMillis(150)));
            assertThrows(ApiException.class,()->library.collection("bank","bank"));
            if(Files.exists(directory()))try(var files=Files.list(directory())){assertEquals(0,files.count());}
        } finally {trace.close();}
    }
}

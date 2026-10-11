package io.quizforge.web;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import static org.junit.jupiter.api.Assertions.*;

class LibraryResourceImportsTest {
    @TempDir Path root;
    Object imports() throws Exception { return Class.forName("io.quizforge.web.LibraryResourceImports").getDeclaredConstructor().newInstance(); }
    void ensure(Object imports, ResourceStore store, Path directory, boolean extension) throws Exception {
        try { imports.getClass().getDeclaredMethod("ensure",ResourceStore.class,Path.class,com.fasterxml.jackson.databind.JsonNode.class,boolean.class).invoke(imports,store,directory,Json.MAPPER.createArrayNode(),extension); }
        catch (java.lang.reflect.InvocationTargetException exception) { if(exception.getCause() instanceof Exception cause) throw cause; throw exception; }
    }
    long count(Object imports) throws Exception { return (long) imports.getClass().getDeclaredMethod("completedImports").invoke(imports); }
    byte[] image(int suffix) { byte[] value = new byte[]{(byte)137,80,78,71,13,10,26,10,0,0,0,0,73,72,68,82,0,0,0,0,0,0,0,0}; value[23]=(byte)suffix; return value; }
    Path assets() throws Exception { Path dir=root.resolve("source"); Files.createDirectories(dir.resolve("assets")); Files.write(dir.resolve("assets/image.png"),image(1)); return dir; }
    @Test void sharedExtensionImportsOnceAndSeparateStoresRemainIndependent() throws Exception {
        Object value=assertDoesNotThrow(this::imports); Path dir=assets(); ResourceStore normal=new ResourceStore(root), development=new ResourceStore(root.resolve("dev"));
        ensure(value,normal,dir,true); ensure(value,normal,dir,true); assertEquals(1,count(value));
        ensure(value,development,dir,true); assertEquals(2,count(value));
        assertArrayEquals(image(1),normal.read(ResourceStore.hash(image(1))).bytes()); assertArrayEquals(image(1),development.read(ResourceStore.hash(image(1))).bytes());
    }
    @Test void changedSourceAndMissingTargetRequireImportAgain() throws Exception {
        Object value=assertDoesNotThrow(this::imports); Path dir=assets(); ResourceStore store=new ResourceStore(root);
        ensure(value,store,dir,false); Files.delete(root.resolve(".state/resources/"+ResourceStore.hash(image(1))+".png"));
        ensure(value,store,dir,false); assertEquals(2,count(value)); assertArrayEquals(image(1),store.read(ResourceStore.hash(image(1))).bytes());
        Files.write(dir.resolve("assets/image.png"),image(2)); ensure(value,store,dir,false); assertEquals(3,count(value));
        assertArrayEquals(image(2),store.read(ResourceStore.hash(image(2))).bytes());
    }
    @Test void invalidBankImageIsNeverCachedAsSuccessful() throws Exception {
        Object value=assertDoesNotThrow(this::imports); Path dir=assets(); Files.writeString(dir.resolve("assets/image.png"),"invalid image");
        assertThrows(java.io.IOException.class,()->ensure(value,new ResourceStore(root),dir,false)); assertEquals(0,count(value));
    }
}

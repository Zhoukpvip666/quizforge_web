package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.*;
import java.io.IOException;
import java.util.*;

/** Optional, bounded success records. No load may depend on cache availability. */
final class ValidationCache {
    private static final long RECORD_BYTES=2L*1024*1024, TOTAL_BYTES=32L*1024*1024;
    private static final Object WRITE_LOCK=new Object();
    private final Path root, directory;
    ValidationCache(Path root) { this.root=root.toAbsolutePath().normalize(); directory=this.root.resolve(".state/validation-cache/v1"); }
    private boolean safe(boolean create) throws IOException {
        Path path=root;
        for(String component:List.of(".state","validation-cache","v1")) {
            path=path.resolve(component);
            if(Files.isSymbolicLink(path) || Files.exists(path,LinkOption.NOFOLLOW_LINKS)&&!Files.isDirectory(path,LinkOption.NOFOLLOW_LINKS)) return false;
            if(create) Files.createDirectories(path);
        }
        return true;
    }
    Optional<CollectionValidation.Check> read(String key,int questionCount) {
        if(key==null || !key.matches("[a-f0-9]{64}") || questionCount<1 || questionCount>10000) return Optional.empty();
        try {
            if(!safe(false)) return Optional.empty(); Path file=directory.resolve(key+".json");
            if(!Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(file) || Files.size(file)>RECORD_BYTES) return Optional.empty();
            JsonNode value=Json.read(file,(int)RECORD_BYTES); JsonNode rows=value.path("outlineItems");
            if(!value.isObject() || value.size()!=4 || !value.path("protocol").asText().equals("quizforge-validation-v1") || !value.path("key").asText().equals(key) || !rows.isArray() || rows.size()!=questionCount || !value.path("checksum").asText().equals(Json.fingerprint(rows,key))) return Optional.empty();
            var outlines=new ArrayList<List<Library.OutlineItem>>(); for(JsonNode row:rows) outlines.add(OutlineItems.read(row));
            return Optional.of(new CollectionValidation.Check(outlines));
        } catch(IOException | RuntimeException failure) { return Optional.empty(); }
    }
    void write(String key,CollectionValidation.Check check) {
        if(key==null || !key.matches("[a-f0-9]{64}")) return;
        synchronized(WRITE_LOCK) {
            Path temporary=null;
            try {
                if(!safe(true)) return;
                JsonNode outlines=Json.MAPPER.valueToTree(check.outlineItems());
                byte[] bytes=Json.MAPPER.writeValueAsBytes(Json.object().put("protocol","quizforge-validation-v1").put("key",key).put("checksum",Json.fingerprint(outlines,key)).set("outlineItems",outlines));
                if(bytes.length>RECORD_BYTES) return; Path target=directory.resolve(key+".json");
                if(Files.isSymbolicLink(target) || Files.exists(target,LinkOption.NOFOLLOW_LINKS)&&!Files.isRegularFile(target,LinkOption.NOFOLLOW_LINKS)) return;
                temporary=Files.createTempFile(directory,".record-",".tmp"); Files.write(temporary,bytes);
                try { Files.move(temporary,target,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING); }
                catch(AtomicMoveNotSupportedException ignored) { Files.move(temporary,target,StandardCopyOption.REPLACE_EXISTING); }
                temporary=null; trim(target);
            } catch(IOException | RuntimeException ignored) { /* Revalidation remains available. */ }
            finally { if(temporary!=null) try {Files.deleteIfExists(temporary);} catch(IOException ignored) { } }
        }
    }
    private void trim(Path keep) throws IOException {
        List<Path> files;
        try(var stream=Files.list(directory)) { files=stream.filter(path->path.getFileName().toString().matches("[a-f0-9]{64}\\.json")&&!Files.isSymbolicLink(path)&&Files.isRegularFile(path,LinkOption.NOFOLLOW_LINKS)).sorted(Comparator.comparingLong(path->{try{return Files.getLastModifiedTime(path).toMillis();}catch(IOException ignored){return 0;}})).toList(); }
        long bytes=0; for(Path file:files) bytes+=Files.size(file); int count=files.size();
        for(Path file:files) {
            if(count<=2048 && bytes<=TOTAL_BYTES) break; if(file.equals(keep)) continue;
            long size=Files.size(file); Files.delete(file); bytes-=size; count--;
        }
    }
}

package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;

/** Imports are shared only after source bytes and stored raster targets are checked. */
final class LibraryResourceImports {
    private record Key(ResourceStore store, Path directory, boolean extension) { }
    private record Imported(String identity, List<String> rasterIds) { }
    private final LinkedHashMap<Key,Imported> imported = new LinkedHashMap<>(16,.75f,true);
    private long completed;
    synchronized long completedImports() { return completed; }
    synchronized void invalidate(Path directory) { imported.keySet().removeIf(key -> key.directory().equals(directory.toAbsolutePath().normalize())); }
    synchronized void ensure(ResourceStore store, Path directory, JsonNode declaredAssets, boolean extension) throws IOException {
        directory = directory.toAbsolutePath().normalize();
        for (JsonNode declared : declaredAssets) Json.safeFile(directory, declared.asText());
        var identities = Json.MAPPER.createArrayNode(); identities.add(declaredAssets); var rasterIds = new ArrayList<String>();
        Path assets = directory.resolve("assets");
        if (Files.exists(assets, LinkOption.NOFOLLOW_LINKS)) {
            if (Files.isSymbolicLink(assets) || !Files.isDirectory(assets, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Unsafe asset directory");
            try (var stream = Files.walk(assets)) {
                List<Path> paths = stream.sorted().limit(1001).toList(); if (paths.size() > 1000) throw new IOException("Too many assets");
                for (Path path : paths) {
                    if (Files.isSymbolicLink(path)) throw new IOException("Unsafe asset");
                    if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) continue;
                    if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) > ResourceStore.MAX_BYTES) throw new IOException("Invalid asset size");
                    byte[] bytes = Files.readAllBytes(path); String hash = ResourceStore.hash(bytes);
                    identities.add(directory.relativize(path).toString()); identities.add(hash);
                    if (ResourceStore.detectMime(bytes) != null) rasterIds.add(hash);
                }
            }
        }
        Key key = new Key(store, directory, extension); String identity = Json.fingerprint(identities, "quizforge-resource-import-v1");
        Imported prior = imported.get(key); boolean valid = prior != null && prior.identity().equals(identity);
        if (valid) for (String id : prior.rasterIds()) try { store.read(id); } catch (IOException | ApiException failure) { valid = false; break; }
        if (valid) return;
        if (extension) store.importExtensionAssets(directory, declaredAssets); else store.importAssets(directory);
        imported.put(key, new Imported(identity, List.copyOf(rasterIds))); completed++;
        while (imported.size() > 256) imported.remove(imported.keySet().iterator().next());
    }
}

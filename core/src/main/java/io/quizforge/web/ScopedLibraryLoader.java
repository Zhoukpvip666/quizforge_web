package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.*;
import java.util.*;

/** A scoped view reuses the authoritative catalog pipeline without unrelated collections. */
final class ScopedLibraryLoader {
    record Loaded(Library.Collection collection, Map<String,Library.Extension> extensions,
                  Map<String,DevelopmentExtensions.Package> developmentPackages, ObjectNode descriptor,
                  String sourceIdentity, ObjectNode catalogRow, Library view, String contentIdentity) { }
    record Scope(List<Path> folders, List<Path> files) { }
    record ObservedIdentity(Scope scope,String environment,String identity) { }
    private final Library library;
    private final LinkedHashMap<String,Loaded> loaded = new LinkedHashMap<>(16, .75f, true);
    private final Map<String,CollectionValidation.Check> checks = new java.util.concurrent.ConcurrentHashMap<>();
    private String runner = "";
    ScopedLibraryLoader(Library library) { this.library = library; }

    Loaded load(LibraryIndex.Snapshot snapshot, String kind, String id) {
        return load(snapshot,kind,id,null);
    }
    ObservedIdentity observe(Scope scope){String environment=library.scopedRunnerRevision();return new ObservedIdentity(scope,environment,library.scopedIdentity(scope.folders(),scope.files(),environment));}
    Loaded load(LibraryIndex.Snapshot snapshot,String kind,String id,ObservedIdentity submitted) {
        for (int attempt = 0; attempt < 2; attempt++) {
            Scope scope = scope(snapshot, kind, id);
            ObservedIdentity before=attempt==0&&submitted!=null&&submitted.scope().equals(scope)?submitted:observe(scope);
            String environment=before.environment(),identity=before.identity();
            String key = kind + ":" + id;
            Loaded cached;
            synchronized (loaded) {
                cached = loaded.get(key);
                String currentRunner = environment;
                if (currentRunner.equals("unavailable") || !runner.equals(currentRunner)) { checks.clear(); runner = currentRunner; }
            }
            if (!environment.equals("unavailable") && cached != null && cached.sourceIdentity().equals(identity) && !transientFailure(cached.catalogRow())) {
                if(cached.view()!=null&&!cached.catalogRow().has("error"))cached.view().ensureLoadedResources();
                if(identity.equals(observe(scope).identity())&&library.scopedModeMatches(snapshot))return cached;
                snapshot=library.indexSnapshot();continue;
            }
            Library view = library.scopedView(scope.folders(), scope.files(), checks,environment);
            Loaded result = view.scopedResult(kind, id, identity);
            ObservedIdentity after = observe(scope);
            if (!identity.equals(after.identity()) || !library.scopedModeMatches(snapshot)) {
                snapshot = library.indexSnapshot(); continue;
            }
            view.persistSuccessfulChecks(after.environment());checks.putAll(view.scopedChecks());
            if (checks.size() > 2048) checks.clear();

            synchronized (loaded) { if(environment.equals("unavailable"))loaded.remove(key);else loaded.put(key, result); while (loaded.size() > 64) loaded.remove(loaded.keySet().iterator().next()); }
            return result;
        }
        throw new ApiException(409, "LIBRARY_CHANGED", "Library files changed while loading; refresh and retry");
    }
    Library.Collection readCached(LibraryIndex.Snapshot snapshot, String kind, String id) {
        Loaded cached;
        synchronized (loaded) { cached = loaded.get(kind + ":" + id); }
        if (cached == null || cached.collection() == null) return null;
        Scope scope = scope(snapshot, kind, id);
        if(!cached.contentIdentity().equals(library.scopedContentIdentity(scope.folders(), scope.files())))return null;
        if(cached.view()!=null)cached.view().ensureLoadedResources(); return cached.collection();
    }
    static boolean transientFailure(JsonNode row) { return List.of("RULE_TIMEOUT", "RULE_UNAVAILABLE").contains(row.path("errorCode").asText()); }
    void rememberFailure(String kind, String id, String identity, ObjectNode row) {
        synchronized (loaded) { loaded.put(kind + ":" + id, new Loaded(null, Map.of(), Map.of(), Json.object(), identity, row.deepCopy(), null, "")); while (loaded.size() > 64) loaded.remove(loaded.keySet().iterator().next()); }
    }
    Scope scope(LibraryIndex.Snapshot snapshot, String kind, String id) {
        var wanted = new HashSet<String>(); var files = new ArrayList<Path>(); var folders = new ArrayList<Path>();
        boolean bank = kind.equals("bank") || kind.equals("development-bank");
        if (bank) for (LibraryIndex.Candidate candidate : snapshot.candidates()) {
            if (!List.of("bank", "development-bank").contains(candidate.kind()) || !candidate.id().equals(id)) continue;
            files.add(candidate.source());
            try {
                JsonNode raw = Json.read(candidate.source(), 8 * 1024 * 1024);
                if (raw.has("extension")) wanted.add(LibraryIndex.referenceKey(raw.path("extension")));
                for (JsonNode question : raw.path("questions")) if (question.has("extension")) wanted.add(LibraryIndex.referenceKey(question.path("extension")));
            } catch (Exception ignored) { /* The same full loader reports the candidate's precise error. */ }
        }
        for (LibraryIndex.Candidate candidate : snapshot.candidates()) {
            if (!List.of("extension", "development").contains(candidate.kind())) continue;
            ObjectNode row = candidate.metadata(); String reference = candidate.kind().equals("development") ? "development:" + candidate.id() : candidate.id() + "@" + row.path("version").asText();
            boolean selected = bank ? wanted.contains(reference) : kind.equals("development") ? candidate.kind().equals(kind) && candidate.id().equals(id)
                    : kind.equals("page") ? reference.equals(id) || candidate.kind().equals("development") && (DevelopmentExtensions.runtimeId(candidate.id()) + "@0.0.0").equals(id)
                    : candidate.kind().equals("extension") && candidate.id().equals(id);
            if (selected) folders.add(candidate.source());
        }
        if (bank ? files.isEmpty() : folders.isEmpty()) throw new ApiException(404, "COLLECTION_NOT_FOUND", "Collection is unavailable");
        return new Scope(List.copyOf(folders), List.copyOf(files));
    }
}

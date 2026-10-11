package io.quizforge.web;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/** Page-owned exam runtimes share the same memory and idle limits as temporary practice. */
final class TemporaryExamSessions implements AutoCloseable {
    private static final int MAX_ATTEMPTS = 32, MAX_DELETIONS = 256;
    private static final long MAX_BYTES = 256L * 1024 * 1024, WRITE_HEADROOM = 32L * 1024 * 1024;
    private static final Duration IDLE = Duration.ofMinutes(30);
    record Runtime(StateStore states, AiGradingService ai, CollectionRoutes routes, ResourceStore resources) implements AutoCloseable {
        long bytes() { return states.memoryBytes() + ai.memoryBytes() + resources.memoryBytes(); }
        @Override public void close() { ai.close(); states.clearMemory(); resources.clearMemory(); }
    }
    private static final class Entry {
        final String owner;
        Runtime runtime;
        long snapshotBytes;
        Instant touched;
        Entry(String owner, Runtime runtime, long snapshotBytes, Instant touched) {
            this.owner = owner; this.runtime = runtime; this.snapshotBytes = snapshotBytes; this.touched = touched;
        }
        long bytes() { return snapshotBytes + (runtime == null ? 0 : runtime.bytes()); }
    }
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final Clock clock;
    TemporaryExamSessions(Clock clock) { this.clock = clock; }

    static void requireOwner(String owner) {
        if (owner == null || owner.isBlank()) throw new ApiException(409, "PRACTICE_SESSION_REQUIRED", "Temporary exams require this browser page's session ID");
        if (!owner.matches("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")) throw ApiException.bad("Invalid practice session ID");
    }
    synchronized Runtime runtime(String id) { Entry entry = entries.get(id); return entry == null ? null : entry.runtime; }
    synchronized boolean contains(String id) { return runtime(id) != null; }
    synchronized void checkAdmission(long snapshotBytes) {
        long attempts = entries.values().stream().filter(entry -> entry.runtime != null).count();
        if (attempts >= MAX_ATTEMPTS || bytes() + snapshotBytes > MAX_BYTES - WRITE_HEADROOM) throw limit();
    }
    synchronized void add(String id, String owner, Runtime runtime, long snapshotBytes) {
        requireOwner(owner); checkAdmission(snapshotBytes);
        entries.put(id, new Entry(owner, runtime, snapshotBytes, clock.instant()));
    }
    synchronized void touchPage(String owner, boolean writing) {
        if (owner == null) return;
        requireOwner(owner);
        if (writing && bytes() > MAX_BYTES - WRITE_HEADROOM) throw limit();
        Instant now = clock.instant();
        for (Entry entry : entries.values()) if (entry.owner.equals(owner)) entry.touched = now;
    }
    synchronized void access(String id, String owner, boolean writing) {
        requireOwner(owner); Entry entry = entries.get(id);
        if (entry == null || entry.runtime == null || !entry.owner.equals(owner))
            throw new ApiException(404, "COLLECTION_NOT_FOUND", "此临时考试属于另一个页面会话或已过期。");
        touchPage(owner, writing);
    }
    private long bytes() { long bytes = 0; for (Entry entry : entries.values()) bytes += entry.bytes(); return bytes; }
    void expire(Consumer<String> invalidate) {
        var expired = new LinkedHashMap<String, Entry>();
        synchronized (this) {
            Instant now = clock.instant(); var iterator = entries.entrySet().iterator();
            while (iterator.hasNext()) {
                var entry = iterator.next();
                if (Duration.between(entry.getValue().touched, now).compareTo(IDLE) >= 0) { expired.put(entry.getKey(), entry.getValue()); iterator.remove(); }
            }
        }
        // Invalidate the collection first, so a late model response cannot discover a usable attempt.
        for (var entry : expired.entrySet()) { invalidate.accept(entry.getKey()); if (entry.getValue().runtime != null) entry.getValue().runtime.close(); }
    }
    void deleted(String id, long snapshotBytes, Consumer<String> invalidate) {
        Runtime runtime; var evicted = new ArrayList<String>();
        synchronized (this) {
            Entry entry = entries.get(id); if (entry == null) return;
            runtime = entry.runtime; entry.runtime = null; entry.snapshotBytes = snapshotBytes; entry.touched = clock.instant();
            long deletions = entries.values().stream().filter(value -> value.runtime == null).count();
            var iterator = entries.entrySet().iterator();
            while (deletions > MAX_DELETIONS && iterator.hasNext()) {
                var old = iterator.next(); if (old.getValue().runtime != null) continue;
                evicted.add(old.getKey()); iterator.remove(); deletions--;
            }
        }
        if (runtime != null) runtime.close(); evicted.forEach(invalidate);
    }
    void discard(String id) {
        Entry entry; synchronized (this) { entry = entries.remove(id); }
        if (entry != null && entry.runtime != null) entry.runtime.close();
    }
    @Override public void close() {
        List<Entry> values; synchronized (this) { values = List.copyOf(entries.values()); entries.clear(); }
        for (Entry value : values) if (value.runtime != null) value.runtime.close();
    }
    private static ApiException limit() { return new ApiException(429, "PRACTICE_SESSION_LIMIT", "Temporary exam capacity is full; existing answers are preserved. Delete unused attempts or retry after idle pages expire"); }
}

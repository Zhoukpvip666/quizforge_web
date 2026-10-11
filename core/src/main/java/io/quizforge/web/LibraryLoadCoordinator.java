package io.quizforge.web;

import java.util.*;
import java.util.concurrent.*;
import java.util.function.Supplier;

/** Separate bounded lanes keep unrelated background validation off the foreground path. */
final class LibraryLoadCoordinator implements AutoCloseable {
    record Key(String kind, String id, String sourceIdentity) { }
    private final Map<Key,Job> jobs = new HashMap<>();
    private final ThreadPoolExecutor foreground = lane("quizforge-library-foreground"), background = lane("quizforge-library-background");
    private boolean closed;
    private static ThreadPoolExecutor lane(String name) {
        return new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(1200), task -> {
            Thread thread = new Thread(task, name); thread.setDaemon(true); return thread;
        });
    }
    synchronized CompletableFuture<ScopedLibraryLoader.Loaded> submit(Key key, Supplier<ScopedLibraryLoader.Loaded> load, boolean priority) {
        if (closed) return CompletableFuture.failedFuture(new IllegalStateException("Library is closed"));
        Job existing = jobs.get(key);
        if (existing != null) {
            if (priority && !existing.started && background.remove(existing)) execute(foreground, existing);
            return existing.result;
        }
        Job job = new Job(key, load); jobs.put(key, job); execute(priority ? foreground : background, job); return job.result;
    }
    private void execute(ThreadPoolExecutor lane, Job job) {
        try { lane.execute(job); }
        catch (RejectedExecutionException failure) { jobs.remove(job.key, job); job.result.completeExceptionally(failure); }
    }
    synchronized void invalidate(Set<Key> current) {
        for (Job job : List.copyOf(jobs.values())) if (!current.contains(job.key)) cancel(job);
    }
    private void cancel(Job job) {
        foreground.remove(job); background.remove(job); jobs.remove(job.key, job);
        job.result.completeExceptionally(new ApiException(409, "LIBRARY_CHANGED", "Library changed while loading"));
    }
    @Override public synchronized void close() {
        if (closed) return; closed = true;
        for (Job job : List.copyOf(jobs.values())) cancel(job);
        foreground.shutdownNow(); background.shutdownNow();
    }
    private final class Job implements Runnable {
        final Key key; final Supplier<ScopedLibraryLoader.Loaded> load;
        final CompletableFuture<ScopedLibraryLoader.Loaded> result = new CompletableFuture<>(); boolean started;
        Job(Key key, Supplier<ScopedLibraryLoader.Loaded> load) { this.key = key; this.load = load; }
        @Override public void run() {
            synchronized (LibraryLoadCoordinator.this) { if (result.isDone()) return; started = true; }
            ScopedLibraryLoader.Loaded value = null; Throwable failure = null;
            try { value = load.get(); } catch (Throwable thrown) { failure = thrown; }
            synchronized (LibraryLoadCoordinator.this) { jobs.remove(key, this); }
            if (failure == null) result.complete(value); else result.completeExceptionally(failure);
        }
    }
}

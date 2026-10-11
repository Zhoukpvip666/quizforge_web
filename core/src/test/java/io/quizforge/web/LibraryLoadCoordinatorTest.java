package io.quizforge.web;

import org.junit.jupiter.api.Test;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import static org.junit.jupiter.api.Assertions.*;

class LibraryLoadCoordinatorTest {
    Object coordinator() throws Exception { return Class.forName("io.quizforge.web.LibraryLoadCoordinator").getDeclaredConstructor().newInstance(); }
    Object key(String id) throws Exception { return Class.forName("io.quizforge.web.LibraryLoadCoordinator$Key").getDeclaredConstructor(String.class,String.class,String.class).newInstance("bank",id,"content-v1"); }
    @SuppressWarnings("unchecked") CompletableFuture<?> submit(Object coordinator, String id, Supplier<?> work, boolean foreground) throws Exception {
        Object key = key(id); return (CompletableFuture<?>) coordinator.getClass().getDeclaredMethod("submit", key.getClass(), Supplier.class, boolean.class).invoke(coordinator,key,work,foreground);
    }
    void close(Object coordinator) throws Exception { coordinator.getClass().getDeclaredMethod("close").invoke(coordinator); }
    Supplier<Object> blocked(CountDownLatch started, CountDownLatch release) { return () -> { started.countDown(); try { release.await(); return null; } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IllegalStateException("interrupted",e); } }; }
    @Test void foregroundCompletesWhileBackgroundIsBlocked() throws Exception {
        Object value = assertDoesNotThrow(this::coordinator); CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        try {
            CompletableFuture<?> background = submit(value,"slow",blocked(started,release),false); assertTrue(started.await(2,TimeUnit.SECONDS));
            assertDoesNotThrow(() -> submit(value,"foreground",() -> null,true).get(2,TimeUnit.SECONDS)); assertFalse(background.isDone());
        } finally { release.countDown(); close(value); }
    }
    @Test void sameContentSharesTaskAndFailedTaskCanBeRetried() throws Exception {
        Object value = assertDoesNotThrow(this::coordinator); CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1); AtomicInteger calls = new AtomicInteger();
        try {
            CompletableFuture<?> first = submit(value,"same",() -> { calls.incrementAndGet(); return blocked(started,release).get(); },false);
            assertTrue(started.await(2,TimeUnit.SECONDS)); CompletableFuture<?> second = submit(value,"same",() -> { calls.incrementAndGet(); return null; },true);
            assertSame(first,second); release.countDown(); first.get(2,TimeUnit.SECONDS); assertEquals(1,calls.get());
            CompletableFuture<?> rejected = submit(value,"bad",() -> { throw new IllegalStateException("bad data"); },true);
            assertThrows(ExecutionException.class,() -> rejected.get(2,TimeUnit.SECONDS));
            assertDoesNotThrow(() -> submit(value,"bad",() -> null,true).get(2,TimeUnit.SECONDS));
        } finally { release.countDown(); close(value); }
    }
    @Test void queuedBackgroundCanBePromotedWithoutDuplicatingWork() throws Exception {
        Object value = assertDoesNotThrow(this::coordinator); CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1); AtomicInteger calls = new AtomicInteger();
        try {
            submit(value,"busy",blocked(started,release),false); assertTrue(started.await(2,TimeUnit.SECONDS));
            CompletableFuture<?> queued = submit(value,"queued",() -> { calls.incrementAndGet(); return null; },false);
            assertSame(queued,submit(value,"queued",() -> { calls.incrementAndGet(); return null; },true));
            queued.get(2,TimeUnit.SECONDS); assertEquals(1,calls.get());
        } finally { release.countDown(); close(value); }
    }
    @Test void closeCancelsQueuedWorkAndRejectsNewRequests() throws Exception {
        Object value = assertDoesNotThrow(this::coordinator); CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        CompletableFuture<?> queued;
        try {
            submit(value,"busy",blocked(started,release),false); assertTrue(started.await(2,TimeUnit.SECONDS)); queued = submit(value,"queued",() -> null,false);
            close(value); assertTrue(queued.isCompletedExceptionally()); assertTrue(submit(value,"later",() -> null,true).isCompletedExceptionally());
        } finally { release.countDown(); close(value); }
    }
    @Test void invalidatedRunningResultCannotCompleteAnOldFuture() throws Exception {
        Object value = coordinator(); CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        try {
            var result = submit(value,"old",blocked(started,release),false); assertTrue(started.await(2,TimeUnit.SECONDS));
            value.getClass().getDeclaredMethod("invalidate", java.util.Set.class).invoke(value, java.util.Set.of());
            release.countDown(); assertTrue(result.isCompletedExceptionally());
        } finally { release.countDown(); close(value); }
    }
}

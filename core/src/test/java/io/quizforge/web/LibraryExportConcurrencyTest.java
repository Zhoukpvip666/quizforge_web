package io.quizforge.web;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpContext;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpPrincipal;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class LibraryExportConcurrencyTest {
    @TempDir Path root;

    @Test void stalledExportOutputDoesNotBlockPracticeStateReadsAndStillRemovesItsSnapshot() throws Exception {
        ServerTest fixture = new ServerTest(); fixture.root = root; fixture.prepare();
        Files.createDirectory(root.resolve("question-banks/practice"));
        Files.move(root.resolve("question-banks/bank.json"), root.resolve("question-banks/practice/questions.json"));
        fixture.start(null);
        var streaming = new CountDownLatch(1); var release = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var serverField = QuizForgeServer.class.getDeclaredField("server"); serverField.setAccessible(true);
            HttpServer server = (HttpServer) serverField.get(fixture.server);
            var exchange = new StalledExchange(server.createContext("/export-test"), streaming, release);
            var handle = QuizForgeServer.class.getDeclaredMethod("handle", HttpExchange.class); handle.setAccessible(true);
            var export = executor.submit(() -> { handle.invoke(fixture.server, exchange); return null; });
            try {
                assertTrue(streaming.await(10, TimeUnit.SECONDS), "Export did not reach its response body");
                var question = executor.submit(() -> fixture.get(ServerTest.QUESTION));
                assertEquals(200, question.get(4, TimeUnit.SECONDS).status());
            } finally { release.countDown(); }
            export.get(5, TimeUnit.SECONDS);
            assertEquals(200, exchange.getResponseCode());
            try (var workspaces = Files.list(root.resolve(".temp"))) {
                assertFalse(workspaces.anyMatch(path -> path.getFileName().toString().startsWith("library-transfer-")));
            }
        } finally { release.countDown(); fixture.close(); }
    }

    private static final class StalledExchange extends HttpExchange {
        private final HttpContext context;
        private final Headers request = new Headers(), response = new Headers();
        private final InputStream body = new ByteArrayInputStream("{\"group\":\"practice\"}".getBytes(StandardCharsets.UTF_8));
        private final OutputStream output;
        private int responseCode = -1;
        StalledExchange(HttpContext context, CountDownLatch streaming, CountDownLatch release) {
            this.context = context;
            request.set("Host", "127.0.0.1:" + context.getServer().getAddress().getPort()); request.set("Content-Type", "application/json");
            output = new OutputStream() {
                @Override public void write(int value) throws IOException { awaitReader(); }
                @Override public void write(byte[] bytes, int offset, int length) throws IOException { awaitReader(); }
                private void awaitReader() throws IOException {
                    streaming.countDown();
                    try { if (!release.await(15, TimeUnit.SECONDS)) throw new IOException("Synthetic slow reader was not released"); }
                    catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
                }
            };
        }
        @Override public Headers getRequestHeaders() { return request; }
        @Override public Headers getResponseHeaders() { return response; }
        @Override public URI getRequestURI() { return URI.create("/api/library/export"); }
        @Override public String getRequestMethod() { return "POST"; }
        @Override public HttpContext getHttpContext() { return context; }
        @Override public void close() { }
        @Override public InputStream getRequestBody() { return body; }
        @Override public OutputStream getResponseBody() { return output; }
        @Override public void sendResponseHeaders(int code, long length) { responseCode = code; }
        @Override public InetSocketAddress getRemoteAddress() { return new InetSocketAddress("127.0.0.1", 40000); }
        @Override public int getResponseCode() { return responseCode; }
        @Override public InetSocketAddress getLocalAddress() { return context.getServer().getAddress(); }
        @Override public String getProtocol() { return "HTTP/1.1"; }
        @Override public Object getAttribute(String name) { return null; }
        @Override public void setAttribute(String name, Object value) { }
        @Override public void setStreams(InputStream input, OutputStream output) { throw new UnsupportedOperationException(); }
        @Override public HttpPrincipal getPrincipal() { return null; }
    }
}

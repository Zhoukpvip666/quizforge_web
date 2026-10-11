package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;

public final class QuizForgeServer implements AutoCloseable {
    private static final com.fasterxml.jackson.databind.ObjectMapper RESOURCE_MAPPER = Json.MAPPER.copy();
    static { RESOURCE_MAPPER.getFactory().setStreamReadConstraints(com.fasterxml.jackson.core.StreamReadConstraints.builder().maxNestingDepth(64).maxStringLength(((ResourceStore.MAX_BYTES + 2) / 3) * 4).maxNumberLength(100).build()); }
    private final Path root;
    private final Path codeRoot;
    private final String token;
    private final HttpServer server;
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
    private final Semaphore requests = new Semaphore(8);
    private final Library library;
    private final RuleEngine engine;
    private final PracticeSessions practiceSessions;
    private final StateStore states;
    private final ResourceStore resources;
    private final EditorDraftStore editorDrafts;
    private final AiSettings aiSettings;
    private final OpenAiCompatibleProvider aiGateway;
    private final AiGradingService aiGrading;
    private final CollectionRoutes collectionRoutes;
    private final DevelopmentSettings developmentSettings;
    private final StateStore developmentStates;
    private final ResourceStore developmentResources;
    private final EditorDraftStore developmentEditorDrafts;
    private final AiGradingService developmentAiGrading;
    private final CollectionRoutes developmentRoutes;
    private final ExamSessions exams;
    private final java.util.concurrent.ScheduledExecutorService examTimer = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> { Thread thread = new Thread(r, "quizforge-exams"); thread.setDaemon(true); return thread; });
    private final Set<String> allowedHosts = new HashSet<>();
    private final Set<String> lanAllowedHosts = new HashSet<>();
    private final Set<String> lanUrls = new HashSet<>();
    private final Set<String> publicIpv6Hosts = new HashSet<>();
    private final java.util.List<NetworkAddresses.Subnet> lanIpv6Subnets = new java.util.ArrayList<>();
    private final boolean ipv6Supported = NetworkAddresses.ipv6Available();
    private final NetworkSettings networkSettings;
    private volatile HttpServer networkServer;
    private volatile String networkError;
    public QuizForgeServer(Path root, String host, int port, String token, String node) throws IOException {
        ProjectLayout layout = ProjectLayout.resolve(root);
        this.root = layout.dataRoot(); this.codeRoot = layout.codeRoot(); this.token = token;
        if (token != null && (token.length() < 16 || token.length() > 256 || !token.matches("[A-Za-z0-9._~-]+"))) throw new IllegalArgumentException("Token must contain 16..256 URL-safe characters");
        // Include Node startup and schema compilation; extension VM execution remains limited to 650ms.
        developmentSettings = new DevelopmentSettings(this.root);
        engine = new RuleEngine(codeRoot, node, Duration.ofSeconds(8)); library = new Library(this.root, codeRoot, engine, developmentSettings); states = new StateStore(this.root, engine);
        resources = new ResourceStore(this.root); editorDrafts = new EditorDraftStore(this.root);
        aiSettings = new AiSettings(this.root); aiGateway = new OpenAiCompatibleProvider(aiSettings, resources);
        aiGrading = new AiGradingService(this.root, states, library, aiGateway);
        collectionRoutes = new CollectionRoutes(library, states, aiGrading, new CollectionRoutes.Writes() {
            public JsonNode read(HttpExchange exchange) throws IOException { return writeRequest(exchange); }
            public void validateOrigin(HttpExchange exchange) { validateWriteOrigin(exchange); }
        }, () -> { var profile = aiSettings.profile(); return profile.enabled() && profile.autoGrade(); });
        Path developmentRoot = this.root.resolve(".development");
        if (Files.isSymbolicLink(developmentRoot) || (Files.exists(developmentRoot, java.nio.file.LinkOption.NOFOLLOW_LINKS) && !Files.isDirectory(developmentRoot, java.nio.file.LinkOption.NOFOLLOW_LINKS))) throw new IOException("Unsafe development state root");
        developmentStates = new StateStore(this.root, engine, developmentRoot); developmentResources = new ResourceStore(developmentRoot); developmentEditorDrafts = new EditorDraftStore(developmentRoot);
        developmentAiGrading = new AiGradingService(developmentRoot, developmentStates, library, new OpenAiCompatibleProvider(aiSettings, developmentResources));
        developmentRoutes = new CollectionRoutes(library, developmentStates, developmentAiGrading, new CollectionRoutes.Writes() {
            public JsonNode read(HttpExchange exchange) throws IOException { return writeRequest(exchange); }
            public void validateOrigin(HttpExchange exchange) { validateWriteOrigin(exchange); }
        }, () -> { var profile = aiSettings.profile(); return profile.enabled() && profile.autoGrade(); });
        practiceSessions = new PracticeSessions(this::createPracticeSession);
        exams = new ExamSessions(this.root, library, states, aiGrading, collectionRoutes, new CollectionRoutes.Writes() {
            public JsonNode read(HttpExchange exchange) throws IOException { return writeRequest(exchange); }
            public void validateOrigin(HttpExchange exchange) { validateWriteOrigin(exchange); }
        }, () -> { var profile = aiSettings.profile(); return profile.enabled() && profile.autoGrade(); });
        exams.resourceGateway(images -> new OpenAiCompatibleProvider(aiSettings, images));
        InetAddress address = InetAddress.getByName(host);
        if (address.isAnyLocalAddress()) {
            for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) for (InetAddress local : Collections.list(network.getInetAddresses())) allowedHosts.add(NetworkAddresses.hostKey(local.getHostAddress().split("%", 2)[0]));
        } else allowedHosts.add(NetworkAddresses.hostKey(address.getHostAddress().split("%", 2)[0]));
        allowedHosts.add("localhost"); allowedHosts.add("127.0.0.1"); allowedHosts.add(NetworkAddresses.hostKey("::1"));
        server = HttpServer.create(new InetSocketAddress(address, port), 64); server.setExecutor(executor); server.createContext("/", this::handle);
        int actualPort = server.getAddress().getPort();
        networkSettings = new NetworkSettings(this.root, Math.max(1024, actualPort == 65535 ? 8788 : actualPort + 1));
        refreshLanHosts();
    }
    public int upgradeShortAnswerBanks() throws IOException { return ShortAnswerUpgrade.run(library, states); }
    public int upgradeShortAnswerAutoBanks() throws IOException { return ShortAnswerAutoUpgrade.run(library, states); }
    public synchronized void start() {
        server.start();
        examTimer.scheduleWithFixedDelay(exams::tick, 1, 1, java.util.concurrent.TimeUnit.SECONDS);
        if (server.getAddress().getAddress().isLoopbackAddress() && networkSettings.config().remoteEnabled()) {
            try { networkServer = createNetworkServer(networkSettings.config().port()); networkServer.start(); }
            catch (IOException e) { networkError = "Saved connection port is unavailable; select another port in settings"; System.err.println(networkError); }
        }
    }
    public int port() { return server.getAddress().getPort(); }
    @Override public synchronized void close() { library.close(); examTimer.shutdownNow(); exams.close(); if (networkServer != null) { networkServer.stop(0); networkServer = null; } networkSettings.invalidateSessions(); practiceSessions.close(); aiGrading.close(); developmentAiGrading.close(); server.stop(0); executor.shutdownNow(); }

    private PracticeSessions.Session createPracticeSession() throws IOException {
        StateStore temporary = StateStore.memory(root, engine, root);
        ResourceStore normalImages = ResourceStore.memory(root, resources), developmentImages = ResourceStore.memory(root.resolve(".development"), developmentResources);
        AiGradingService normalAi = AiGradingService.memory(root, temporary, library, new OpenAiCompatibleProvider(aiSettings, normalImages));
        AiGradingService developmentAi;
        try { developmentAi = AiGradingService.memory(root.resolve(".development"), temporary, library, new OpenAiCompatibleProvider(aiSettings, developmentImages)); }
        catch (IOException | RuntimeException error) { normalAi.close(); throw error; }
        CollectionRoutes.Writes writes = new CollectionRoutes.Writes() {
            public JsonNode read(HttpExchange exchange) throws IOException { return writeRequest(exchange); }
            public void validateOrigin(HttpExchange exchange) { validateWriteOrigin(exchange); }
        };
        java.util.function.BooleanSupplier automaticAi = () -> { var profile = aiSettings.profile(); return profile.enabled() && profile.autoGrade(); };
        return new PracticeSessions.Session(temporary, normalImages, developmentImages, normalAi, developmentAi,
                new CollectionRoutes(library, temporary, normalAi, writes, automaticAi), new CollectionRoutes(library, temporary, developmentAi, writes, automaticAi));
    }
    private PracticeSessions.Lease practiceSession(HttpExchange exchange, boolean create, boolean writing) throws IOException {
        return practiceSessions.acquire(exchange.getRequestHeaders().getFirst("X-QuizForge-Practice-Session"), create, writing);
    }
    private ResourceStore.Resource readResource(HttpExchange exchange, String id, boolean development) throws IOException {
        try (PracticeSessions.Lease lease = practiceSession(exchange, false, false)) {
            ResourceStore store = lease == null ? (development ? developmentResources : resources) : (development ? lease.session.developmentResources : lease.session.resources);
            return store.read(id);
        }
    }
    private JsonNode uploadResource(HttpExchange exchange, boolean development) throws IOException {
        String flag = exchange.getRequestHeaders().getFirst("X-QuizForge-Transient-Resource");
        if (flag != null && !flag.equals("true")) throw ApiException.bad("Invalid temporary resource flag");
        if (flag == null) return (development ? developmentResources : resources).upload(writeRequest(exchange, true));
        try (PracticeSessions.Lease lease = practiceSession(exchange, true, true)) {
            synchronized (lease.session) { return (development ? lease.session.developmentResources : lease.session.resources).upload(writeRequest(exchange, true)); }
        }
    }

    private HttpServer createNetworkServer(int port) throws IOException {
        refreshLanHosts();
        // The JDK's IPv6 wildcard socket accepts both families. Use IPv4 on systems without IPv6.
        HttpServer candidate = HttpServer.create(new InetSocketAddress(InetAddress.getByName(ipv6Supported ? "::" : "0.0.0.0"), port), 64);
        candidate.setExecutor(executor); candidate.createContext("/", this::handle); return candidate;
    }
    private void refreshLanHosts() throws IOException {
        Set<String> hosts = new HashSet<>(Set.of("localhost", "127.0.0.1")), urls = new HashSet<>(), globalIpv6 = new HashSet<>();
        var subnets = new java.util.ArrayList<NetworkAddresses.Subnet>();
        if (ipv6Supported) hosts.add(NetworkAddresses.hostKey("::1"));
        for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
            if (!network.isUp()) continue;
            for (var entry : network.getInterfaceAddresses()) {
                InetAddress local = entry.getAddress();
                if (local == null || (!ipv6Supported && local instanceof java.net.Inet6Address) || !NetworkAddresses.usable(local)) continue;
                String host = NetworkAddresses.hostKey(local.getHostAddress().split("%", 2)[0]);
                hosts.add(host); urls.add(host);
                if (NetworkAddresses.globalIpv6(local)) {
                    globalIpv6.add(host); subnets.add(new NetworkAddresses.Subnet(local, entry.getNetworkPrefixLength()));
                }
            }
        }
        synchronized (lanAllowedHosts) {
            lanAllowedHosts.clear(); lanAllowedHosts.addAll(hosts); lanUrls.clear(); lanUrls.addAll(urls);
            publicIpv6Hosts.clear(); publicIpv6Hosts.addAll(globalIpv6); lanIpv6Subnets.clear(); lanIpv6Subnets.addAll(subnets);
        }
    }
    private boolean isRemoteConnection(HttpExchange exchange) { return exchange.getHttpContext().getServer() != server; }
    private boolean canManageNetwork(HttpExchange exchange) {
        if (isRemoteConnection(exchange) || forwardedRequest(exchange) || !server.getAddress().getAddress().isLoopbackAddress() || !exchange.getRemoteAddress().getAddress().isLoopbackAddress()) return false;
        String host = URI.create("http://" + exchange.getRequestHeaders().getFirst("Host")).getHost();
        if (host == null) return false; host = host.replace("[", "").replace("]", "");
        return host.equalsIgnoreCase("localhost") || host.equals("127.0.0.1") || NetworkAddresses.sameHost(host, "::1");
    }
    private synchronized JsonNode networkStatus(boolean canManage) {
        NetworkSettings.Config settings = networkSettings.config();
        var response = Json.object().put("canManage", canManage).put("enabled", networkServer != null && settings.enabled()).put("publicEnabled", networkServer != null && settings.publicEnabled())
                .put("publicUrl", settings.publicUrl()).put("port", settings.port()).put("passwordConfigured", settings.passwordConfigured()).put("ipv6Supported", ipv6Supported);
        try { refreshLanHosts(); }
        catch (IOException unavailable) { response.put("error", "无法刷新本机连接地址，请检查网络适配器后重新打开设置。"); }
        var urls = response.putArray("urls");
        if (networkServer != null && settings.enabled()) {
            synchronized (lanAllowedHosts) { lanUrls.stream().sorted().forEach(host -> urls.add(NetworkAddresses.url(host, settings.port()))); }
        }
        var ipv6Urls = response.putArray("publicIpv6Urls");
        synchronized (lanAllowedHosts) { publicIpv6Hosts.stream().sorted().forEach(host -> ipv6Urls.add(NetworkAddresses.url(host, settings.port()))); }
        if (networkError != null) response.put("error", networkError);
        if (!canManage) response.put("error", "Network settings can only be changed through the local-only server");
        return response;
    }
    private synchronized JsonNode updateNetwork(JsonNode request) {
        NetworkSettings.Config replacement = networkSettings.candidate(request, port());
        HttpServer previous = networkServer, candidate = previous;
        try {
            if (replacement.remoteEnabled() && (previous == null || previous.getAddress().getPort() != replacement.port())) { candidate = createNetworkServer(replacement.port()); candidate.start(); }
            networkSettings.save(replacement);
        } catch (IOException | RuntimeException e) {
            if (candidate != null && candidate != previous) candidate.stop(0);
            throw new ApiException(409, "LAN_SETTINGS_UNAVAILABLE", "Could not save connection settings or open this port; current settings remain active");
        }
        networkServer = replacement.remoteEnabled() ? candidate : null;
        if (previous != null && previous != networkServer) previous.stop(0);
        networkError = null; return networkStatus(true);
    }

    private void handle(HttpExchange exchange) throws IOException {
        boolean acquired = requests.tryAcquire();
        try {
            exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff"); exchange.getResponseHeaders().set("Referrer-Policy", "no-referrer"); exchange.getResponseHeaders().set("Cache-Control", "no-store");
            if (!acquired) throw new ApiException(503, "SERVER_BUSY", "Server is busy; try again");
            validateHost(exchange);
            String path = exchange.getRequestURI().getPath();
            if (path == null || path.contains("\\") || path.contains("\0") || path.contains("//")) throw ApiException.bad("Invalid path");
            if (path.startsWith("/api/")) {
                if (!path.equals("/api/auth/login")) authenticate(exchange);
                if (path.startsWith("/api/resources/") && exchange.getRequestMethod().equals("GET")) {
                    ResourceStore.Resource resource = readResource(exchange, path.substring("/api/resources/".length()), false);
                    send(exchange, 200, resource.mime(), resource.bytes());
                } else if (path.startsWith("/api/development/resources/") && exchange.getRequestMethod().equals("GET")) {
                    developmentSettings.requireEnabled(); ResourceStore.Resource resource = readResource(exchange, path.substring("/api/development/resources/".length()), true);
                    send(exchange, 200, resource.mime(), resource.bytes());
                } else if (path.equals("/api/library/export") && exchange.getRequestMethod().equals("POST")) {
                    requireLocalLibrary(exchange); JsonNode body = writeRequest(exchange); String group = Json.text(body, "group", 120);
                    LibraryArchive.Download snapshot;
                    synchronized (states) { synchronized (developmentStates) {
                        states.recover(); developmentStates.recover();
                        snapshot = library.exportGroup(group);
                    } }
                    try (LibraryArchive.Download download = snapshot) {
                        exchange.getResponseHeaders().set("Content-Type", LibraryArchive.MIME);
                        exchange.getResponseHeaders().set("Content-Disposition", "attachment; filename=quizforge-group.qbank; filename*=UTF-8''" + java.net.URLEncoder.encode(group + ".qbank", StandardCharsets.UTF_8).replace("+", "%20"));
                        exchange.sendResponseHeaders(200, Files.size(download.file())); Files.copy(download.file(), exchange.getResponseBody());
                    }
                } else { JsonNode response = api(exchange, path); json(exchange, 200, response); }
            } else {
                if (!exchange.getRequestMethod().equals("GET")) throw new ApiException(405, "METHOD_NOT_ALLOWED", "Only GET is supported for pages");
                String file = path.equals("/") ? "index.html" : path.substring(1);
                if (file.startsWith("web/")) file = file.substring(4);
                String mime = contentType(file); if (mime == null) throw new ApiException(404, "NOT_FOUND", "Page not found");
                Path asset;
                try { asset = Json.safeFile(codeRoot.resolve("web"), file); }
                catch (IOException e) { throw new ApiException(404, "NOT_FOUND", "Page not found"); }
                if (Files.size(asset) > 4 * 1024 * 1024) throw new ApiException(413, "ASSET_SIZE_LIMIT", "Page asset exceeds the size limit");
                exchange.getResponseHeaders().set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
                send(exchange, 200, mime, Files.readAllBytes(asset));
            }
        } catch (ApiException e) { error(exchange, e.status, e.code, e.getMessage()); }
        catch (AiProviderException e) { error(exchange, e.retryable ? 503 : 422, e.code, e.getMessage()); }
        catch (Exception e) { System.err.println("Request failed: " + e.getClass().getSimpleName()); error(exchange, 500, "INTERNAL_ERROR", "Request could not be completed"); }
        finally { if (acquired) requests.release(); exchange.close(); }
    }
    private JsonNode api(HttpExchange exchange, String path) throws IOException {
        String method = exchange.getRequestMethod(); String[] parts = path.substring(1).split("/", -1);
        if (path.equals("/api/auth/login") && method.equals("POST")) {
            JsonNode body = writeRequest(exchange); String password = Json.text(body, "password", 256);
            if (isRemoteConnection(exchange)) return Json.object().put("token", networkSettings.login(password, exchange.getRemoteAddress().getAddress().getHostAddress()));
            networkSettings.limitLogin(exchange.getRemoteAddress().getAddress().getHostAddress());
            if (token == null || !MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), password.getBytes(StandardCharsets.UTF_8))) throw new ApiException(401, "PASSWORD_REQUIRED", "Incorrect access password");
            return Json.object().put("token", token);
        }
        if (path.equals("/api/settings/network")) {
            boolean canManage = canManageNetwork(exchange);
            if (isRemoteConnection(exchange) || (!server.getAddress().getAddress().isLoopbackAddress() && !exchange.getRemoteAddress().getAddress().isLoopbackAddress())) throw new ApiException(403, "LOCAL_SETTINGS_ONLY", "Open settings on the host computer using its local address");
            if (method.equals("GET")) return networkStatus(canManage);
            if (method.equals("PUT")) {
                if (!canManage) throw new ApiException(403, "LOCAL_SETTINGS_ONLY", "Network settings require the local-only server and a loopback address");
                return updateNetwork(writeRequest(exchange));
            }
        }
        if (path.equals("/api/settings/ai") || path.equals("/api/settings/ai/test") || path.equals("/api/settings/ai/credential")) {
            boolean canManage = canManageNetwork(exchange);
            if (path.equals("/api/settings/ai") && method.equals("GET")) return aiSettings.status().put("canManage", canManage);
            if (!canManage) throw new ApiException(403, "LOCAL_SETTINGS_ONLY", "请在运行 QuizForge 的电脑上使用本机地址修改 AI 设置");
            if (path.equals("/api/settings/ai/credential") && method.equals("GET")) return aiSettings.credential();
            if (path.equals("/api/settings/ai") && method.equals("PUT")) return aiSettings.update(writeRequest(exchange)).put("canManage", true);
            if (path.endsWith("/test") && method.equals("POST")) { writeRequest(exchange); return aiGateway.testConnection(); }
        }
        if (path.equals("/api/settings/development")) {
            boolean canManage = canManageNetwork(exchange);
            if (method.equals("GET")) return developmentSettings.status(canManage);
            if (method.equals("PUT")) {
                if (!canManage) throw new ApiException(403, "LOCAL_SETTINGS_ONLY", "Developer mode can only be changed on the host computer");
                return developmentSettings.update(writeRequest(exchange));
            }
        }
        if (parts.length >= 3 && parts[1].equals("development")) {
            developmentSettings.requireEnabled(); rejectTypeQuery(exchange);
            if (parts.length == 3 && parts[2].equals("resources") && method.equals("POST")) return uploadResource(exchange, true);
            if (parts.length == 5 && parts[2].equals("editor-drafts")) {
                String bank = routeId(parts[3]), question = routeId(parts[4]);
                // Ensure this source is a runtime development bank before creating test drafts.
                String kind = queryValue(exchange, "kind"); if (kind == null) kind = "development-bank";
                if (!kind.equals("development-bank") && !kind.equals("development")) throw ApiException.bad("Invalid editor draft collection kind");
                Library.Collection collection = library.collection(kind, bank); collection.question(question); collection.features().requireEditing(); collection.features().requireHistory();
                String scope = "development-" + ResourceStore.hash(((kind.equals("development") ? "sample:" : "") + bank + ":" + collection.extensionFingerprint()).getBytes(StandardCharsets.UTF_8));
                if (method.equals("GET")) return developmentEditorDrafts.get(scope, question);
                if (method.equals("PUT")) return developmentEditorDrafts.put(scope, question, writeRequest(exchange));
                if (method.equals("DELETE")) { validateWriteOrigin(exchange); return developmentEditorDrafts.delete(scope, question); }
            }
            if (parts.length >= 4 && parts[2].equals("extensions")) {
                String folder = routeId(parts[3]);
                if (parts.length == 4 && method.equals("GET")) return library.development(folder).put("canPublish", canManageNetwork(exchange));
                if (parts.length == 5 && parts[4].equals("revision") && method.equals("GET")) return library.developmentRevision(folder);
                if (parts.length == 5 && parts[4].equals("page") && method.equals("GET")) return library.development(folder).path("page");
                if (parts.length == 5 && parts[4].equals("publish")) {
                    if (!canManageNetwork(exchange)) throw new ApiException(403, "LOCAL_SETTINGS_ONLY", "Publish development extensions on the host computer");
                    if (method.equals("GET")) return library.developmentPublishPlan(folder);
                    if (method.equals("POST")) return library.publishDevelopment(folder, writeRequest(exchange));
                }
            }
            if (parts.length >= 4 && parts[2].equals("banks")) {
                String id = routeId(parts[3]);
                if (parts.length == 4 && method.equals("GET")) return library.developmentBank(id);
                if (parts.length == 5 && parts[4].equals("revision") && method.equals("GET")) return library.developmentBankRevision(id);
            }
        }
        if (parts.length == 2 && parts[1].equals("health") && method.equals("GET")) return Json.object().put("ok", true);
        if (path.equals("/api/resources") && method.equals("POST")) return uploadResource(exchange, false);
        if (parts.length == 4 && parts[1].equals("sdk") && method.equals("GET")) return library.sdk(routeId(parts[2]), routeId(parts[3]));
        if (parts.length == 5 && parts[1].equals("sdk") && parts[4].equals("editor") && method.equals("GET")) return library.sdk(routeId(parts[2]), routeId(parts[3]), true);
        if (parts.length == 4 && parts[1].equals("editor-drafts")) {
            String bank = routeId(parts[2]), question = routeId(parts[3]);
            String kind = queryValue(exchange, "kind"); if (kind == null) kind = "bank";
            if (!kind.equals("bank") && !kind.equals("extension")) throw ApiException.bad("Invalid editor draft collection kind");
            try { Library.Collection collection = library.collection(kind, bank); collection.features().requireEditing(); collection.features().requireHistory(); if (kind.equals("extension")) collection.question(question); }
            catch (ApiException error) { if (!kind.equals("bank") || !error.code.equals("COLLECTION_NOT_FOUND")) throw error; }
            String scope = kind.equals("bank") ? bank : "sample-" + ResourceStore.hash(bank.getBytes(StandardCharsets.UTF_8));
            if (method.equals("GET")) return editorDrafts.get(scope, question);
            if (method.equals("PUT")) return editorDrafts.put(scope, question, writeRequest(exchange));
            if (method.equals("DELETE")) { validateWriteOrigin(exchange); return editorDrafts.delete(scope, question); }
        }
        if (path.startsWith("/api/extensions/") || path.startsWith("/api/development/")) rejectTypeQuery(exchange);
        if (path.equals("/api/library/index") && method.equals("GET")) return library.index().put("canManage", canManageNetwork(exchange));
        if (parts.length == 2 && parts[1].equals("catalog") && method.equals("GET")) { states.recover(); return library.catalog().put("canManage", canManageNetwork(exchange)); }
        if (path.equals("/api/library/import") && method.equals("POST")) {
            requireLocalLibrary(exchange); validateWriteOrigin(exchange);
            String type = exchange.getRequestHeaders().getFirst("Content-Type");
            if (type == null || !type.split(";", 2)[0].strip().equalsIgnoreCase(LibraryArchive.MIME)) throw new ApiException(415, "QBANK_REQUIRED", "请上传 QuizForge .qbank 文件");
            synchronized (states) { synchronized (developmentStates) {
                states.recover(); developmentStates.recover(); return library.importArchive(exchange.getRequestBody());
            } }
        }
        if (path.equals("/api/library/manage") && method.equals("POST")) {
            if (!canManageNetwork(exchange)) throw new ApiException(403, "LOCAL_SETTINGS_ONLY", "目录管理只能在主机本机地址操作");
            JsonNode body = writeRequest(exchange);
            if (body.path("kind").asText().equals("extension")) developmentSettings.requireEnabled();
            // Match StateStore.edit lock ordering: saved question edits cannot commit into an old moved path.
            synchronized (states) { synchronized (developmentStates) { states.recover(); developmentStates.recover(); return library.manage(body); } }
        }
        if (parts.length == 5 && parts[1].equals("extensions") && parts[4].equals("page") && method.equals("GET")) return library.page(routeId(parts[2]), routeId(parts[3]));
        if (parts.length >= 4 && parts[1].equals("collections")) {
            if (parts[2].equals("exam")) return exams.route(exchange, method, parts);
            if (parts.length == 5 && parts[4].equals("exams")) {
                if (method.equals("GET")) return exams.list(parts[2], routeId(parts[3]), exchange.getRequestHeaders().getFirst("X-QuizForge-Practice-Session"));
                if (method.equals("POST")) return exams.start(library.collection(parts[2], routeId(parts[3])), writeRequest(exchange), exchange.getRequestHeaders().getFirst("X-QuizForge-Practice-Session"));
            }
            boolean development = parts[2].startsWith("development"); if (development) developmentSettings.requireEnabled();
            if (parts.length >= 5 && parts[4].equals("history")) {
                boolean bank = parts[2].equals("bank") || parts[2].equals("development-bank");
                if (bank && parts.length == 6 && ExamSessions.isHistoryId(parts[5]) && (method.equals("GET") || method.equals("DELETE"))) {
                    try { library.collection(parts[2], routeId(parts[3])).features().requireHistory(); }
                    catch (ApiException error) { if (!error.code.equals("COLLECTION_NOT_FOUND")) throw error; }
                    if (method.equals("DELETE")) validateWriteOrigin(exchange);
                    return exams.history(parts[2], routeId(parts[3]), parts[5], method.equals("DELETE"));
                }
                JsonNode history = (development ? developmentRoutes : collectionRoutes).route(exchange, method, parts);
                return bank && parts.length == 5 && method.equals("GET") ? exams.appendHistory(parts[2], routeId(parts[3]), (ObjectNode) history) : history;
            }
            boolean readQuestion = method.equals("GET") && parts.length >= 6 && parts[4].equals("questions") && (parts.length == 6 || parts.length == 7 && parts[6].equals("stamp"));
            Library.Collection collection = readQuestion ? library.readCollection(parts[2], routeId(parts[3])) : library.collection(parts[2], routeId(parts[3]));
            if (collection.features().history()) return (development ? developmentRoutes : collectionRoutes).route(exchange, method, parts);
            try (PracticeSessions.Lease lease = practiceSession(exchange, true, !method.equals("GET"))) {
                synchronized (lease.session) { return (development ? lease.session.developmentRoutes : lease.session.routes).route(exchange, method, parts); }
            }
        }
        if (!method.equals("GET") && !method.equals("POST")) throw new ApiException(405, "METHOD_NOT_ALLOWED", "Method is not supported");
        throw new ApiException(404, "NOT_FOUND", "Endpoint not found");
    }
    private void requireLocalLibrary(HttpExchange exchange) {
        if (!canManageNetwork(exchange)) throw new ApiException(403, "LOCAL_SETTINGS_ONLY", "题库导入导出只能在主机本机地址操作");
    }
    private JsonNode writeRequest(HttpExchange exchange) throws IOException {
        return writeRequest(exchange, false);
    }
    private JsonNode writeRequest(HttpExchange exchange, boolean resource) throws IOException {
        validateWriteOrigin(exchange); String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.toLowerCase(Locale.ROOT).split(";", 2)[0].strip().equals("application/json")) throw new ApiException(415, "JSON_REQUIRED", "Content-Type must be application/json");
        byte[] bytes = exchange.getRequestBody().readNBytes(8 * 1024 * 1024 + 1); if (bytes.length > 8 * 1024 * 1024) throw new ApiException(413, "BODY_TOO_LARGE", "Request exceeds the size limit");
        try { return (resource ? RESOURCE_MAPPER : Json.MAPPER).readTree(bytes); } catch (IOException e) { throw ApiException.bad("Malformed JSON"); }
    }
    private void authenticate(HttpExchange exchange) {
        if (isRemoteConnection(exchange)) {
            if (!networkSettings.authenticated(exchange.getRequestHeaders().getFirst("X-QuizForge-Token"))) throw new ApiException(401, "PASSWORD_REQUIRED", "Enter the connection password");
            return;
        }
        if (token == null) return;
        String candidate = exchange.getRequestHeaders().getFirst("X-QuizForge-Token");
        if (candidate == null || !MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), candidate.getBytes(StandardCharsets.UTF_8))) throw new ApiException(401, "TOKEN_REQUIRED", "Enter a valid access token to use this server");
    }
    private void validateHost(HttpExchange exchange) {
        String authority = exchange.getRequestHeaders().getFirst("Host"); if (authority == null) throw ApiException.bad("Missing Host header");
        URI uri; try { uri = URI.create("http://" + authority); } catch (IllegalArgumentException e) { throw ApiException.bad("Invalid Host header"); }
        String host = NetworkAddresses.hostKey(uri.getHost());
        if (host == null || uri.getRawUserInfo() != null || !uri.getRawPath().isEmpty() || uri.getRawQuery() != null || uri.getRawFragment() != null)
            throw new ApiException(403, "HOST_REJECTED", "Use an enabled connection address");
        boolean acceptedHost;
        if (isRemoteConnection(exchange)) {
            NetworkSettings.Config settings = networkSettings.config();
            if (publicHost(uri, settings)) return;
            synchronized (lanAllowedHosts) {
                InetAddress peer = exchange.getRemoteAddress().getAddress();
                acceptedHost = settings.enabled() && (localNetworkPeer(peer) || lanIpv6Subnets.stream().anyMatch(subnet -> subnet.contains(peer))) && lanAllowedHosts.contains(host);
            }
        } else {
            // A proxy must use the password-protected connection port, never the local administrator port.
            acceptedHost = allowedHosts.contains(host) && !(server.getAddress().getAddress().isLoopbackAddress() && forwardedRequest(exchange));
        }
        int port = uri.getPort() == -1 ? 80 : uri.getPort();
        if (!acceptedHost || port != exchange.getLocalAddress().getPort()) throw new ApiException(403, "HOST_REJECTED", "Use an enabled connection address");
    }
    static boolean localNetworkPeer(InetAddress address) { return address.isLoopbackAddress() || address.isSiteLocalAddress() || address.isLinkLocalAddress() || NetworkAddresses.uniqueLocal(address); }
    private static boolean forwardedRequest(HttpExchange exchange) {
        return exchange.getRequestHeaders().keySet().stream().anyMatch(name -> name.equalsIgnoreCase("Forwarded") || name.toLowerCase(Locale.ROOT).startsWith("x-forwarded-"));
    }
    private static boolean publicHost(URI authority, NetworkSettings.Config settings) {
        if (!settings.publicEnabled()) return false;
        URI publicAddress = URI.create(settings.publicUrl());
        int defaultPort = publicAddress.getScheme().equals("https") ? 443 : 80;
        return NetworkAddresses.sameHost(publicAddress.getHost(), authority.getHost())
                && (publicAddress.getPort() == -1 ? defaultPort : publicAddress.getPort()) == (authority.getPort() == -1 ? defaultPort : authority.getPort());
    }
    private void validateWriteOrigin(HttpExchange exchange) {
        String origin = exchange.getRequestHeaders().getFirst("Origin"), fetchSite = exchange.getRequestHeaders().getFirst("Sec-Fetch-Site");
        if (fetchSite != null && !fetchSite.equals("same-origin") && !fetchSite.equals("none")) throw new ApiException(403, "ORIGIN_REJECTED", "Writes require the same origin");
        if (origin == null) return; // Non-browser clients; JSON Content-Type still prevents cross-origin form writes.
        URI uri; try { uri = URI.create(origin); } catch (IllegalArgumentException e) { throw new ApiException(403, "ORIGIN_REJECTED", "Writes require the same origin"); }
        URI authority = URI.create("http://" + exchange.getRequestHeaders().getFirst("Host"));
        NetworkSettings.Config settings = networkSettings.config();
        URI expected = isRemoteConnection(exchange) && publicHost(authority, settings) ? URI.create(settings.publicUrl()) : authority;
        int defaultPort = "https".equals(expected.getScheme()) ? 443 : 80;
        if (!expected.getScheme().equals(uri.getScheme()) || !NetworkAddresses.sameHost(expected.getHost(), uri.getHost())
                || (expected.getPort() == -1 ? defaultPort : expected.getPort()) != (uri.getPort() == -1 ? defaultPort : uri.getPort())
                || uri.getRawUserInfo() != null || !uri.getRawPath().isEmpty() || uri.getRawQuery() != null || uri.getRawFragment() != null)
            throw new ApiException(403, "ORIGIN_REJECTED", "Writes require the same origin");
    }
    private static void rejectTypeQuery(HttpExchange exchange) {
        String query = exchange.getRequestURI().getRawQuery(); if (query == null) return;
        for (String parameter : query.split("&")) {
            String key; try { key = java.net.URLDecoder.decode(parameter.split("=", 2)[0], StandardCharsets.UTF_8); }
            catch (IllegalArgumentException error) { throw ApiException.bad("Invalid query"); }
            if (key.equals("typeId")) throw ApiException.bad("typeId routes are unsupported; each extension provides one question type");
        }
    }
    private static String queryValue(HttpExchange exchange, String name) {
        String query = exchange.getRequestURI().getRawQuery(), result = null; if (query == null) return null;
        try { for (String parameter : query.split("&")) { String[] pair = parameter.split("=", 2); if (java.net.URLDecoder.decode(pair[0], StandardCharsets.UTF_8).equals(name)) { if (result != null || pair.length != 2) throw ApiException.bad("Invalid query"); result = java.net.URLDecoder.decode(pair[1], StandardCharsets.UTF_8); } } }
        catch (IllegalArgumentException error) { throw ApiException.bad("Invalid query"); } return result;
    }
    private static String routeId(String value) { if (!value.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,119}")) throw ApiException.bad("Invalid resource ID"); return value; }

    private static String contentType(String file) { String lower = file.toLowerCase(Locale.ROOT); if (lower.endsWith(".html")) return "text/html; charset=utf-8"; if (lower.endsWith(".js")) return "text/javascript; charset=utf-8"; if (lower.endsWith(".css")) return "text/css; charset=utf-8"; if (lower.endsWith(".svg")) return "image/svg+xml"; if (lower.endsWith(".png")) return "image/png"; if (lower.endsWith(".ico")) return "image/x-icon"; if (lower.endsWith(".woff2")) return "font/woff2"; return null; }
    private static void error(HttpExchange exchange, int status, String code, String message) throws IOException { var error = Json.object(); error.set("error", Json.object().put("code", code).put("message", message)); json(exchange, status, error); }
    private static void json(HttpExchange exchange, int status, JsonNode value) throws IOException { send(exchange, status, "application/json; charset=utf-8", Json.MAPPER.writeValueAsBytes(value)); }
    private static void send(HttpExchange exchange, int status, String contentType, byte[] bytes) throws IOException { exchange.getResponseHeaders().set("Content-Type", contentType); exchange.sendResponseHeaders(status, bytes.length); exchange.getResponseBody().write(bytes); }
}

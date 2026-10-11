# Catalog Startup Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首次进入先显示题库目录，打开时仅校验所需集合，并保持校验与状态兼容。

**Architecture:** 轻量索引和完整集合加载分离；现有完整目录与新按需加载共用校验实现。任务协调器在锁外执行规则，以成功缓存和资源导入复用减少重复工作。

**Tech Stack:** Java 21 源码目标、现有 Jackson/JUnit、Node 24 规则运行器、原生浏览器 JavaScript、现有 node:test/jsdom。

**Spec:** `docs/superpowers/specs/2026-10-11-catalog-startup-design.md`（用户已确认）。

## Global Constraints

- 保留 `/api/catalog` 的完整校验契约及响应；新增 `GET /api/library/index`。
- 轻量目录不得启动 Node，不导入图片，不生成完整大纲，不读取所有页面及 SDK 内容。
- 每行 `validationStatus`：`pending`、`checking`、`ready`、`error`；完整加载后才能返回原语义的 `contentRevision`。
- 保留自动打开首个题库的行为；页面可见期间每 2 秒更新待完成的校验状态。
- 最多运行一个后台集合校验和一个前台集合校验；相同内容身份共用任务。
- 文件读取、资源导入和 Node 调用在目录锁外执行；过期结果不得提交。
- 缓存目录 `.state/validation-cache/v1/`；单条 2 MiB，总量 32 MiB，最多 2,048 条。
- 不迁移或清理用户源文件、题库、答案和配置；不更换 Java、不安装依赖、不重启当前实际服务。
- 首题整库答题状态计算和接口合并不在本次范围；整页冷启动至少测三次，并另测带缓存重启。
- 每个实现提交只包含本任务的增量。已有大量用户未提交修改，不得直接提交整个被修改文件；无法安全区分增量时保留工作区并记录原因，不提交用户修改。

## Review Focus

1. 多个并发请求打开同一坏库：共用失败结果，失败任务移除，修复后可以重试（Task 4）。
2. 目录有多个同 ID 候选且前者坏：按原顺序找到首个有效集合，错误行不会错误拥有 ID（Task 3）。
3. 持久缓存已有成功记录但资源文件丢失：必须修复资源或报错，不返回虚假的 ready（Task 5）。
4. 页面隐藏、登录重试和手动刷新交错：停止旧轮询、丢弃旧响应，不覆盖编辑输入（Task 7）。
5. 规则依赖或 Node 内容在同版本下被替换：缓存环境身份变化，旧成功记录失效（Task 6）。

## File Structure

- `core/src/main/java/io/quizforge/web/CollectionValidation.java`：现有集合宿主准备、规则检查、大纲结果应用的唯一实现。
- `core/src/main/java/io/quizforge/web/LibraryIndex.java`：轻量候选扫描与不可变索引快照。
- `core/src/main/java/io/quizforge/web/ScopedLibraryLoader.java`：指定集合及所需扩展加载，输出独立加载结果。
- `core/src/main/java/io/quizforge/web/LibraryLoadCoordinator.java`：任务去重、前台优先、有限后台执行和关闭。
- `core/src/main/java/io/quizforge/web/LibraryResourceImports.java`：按 ResourceStore/目录/内容身份复用导入。
- `core/src/main/java/io/quizforge/web/ValidationCache.java`：成功校验的有界、原子持久缓存。
- `Library.java`：保留公共宿主入口，协调快照、加载结果和写入失效；不保留另一套集合校验。
- `QuizForgeServer.java`：目录新路由、鉴权及协调器生命周期。
- `core/web/library-index-client.js`：轻量刷新与状态轮询；`app.js` 接入，`views/library-view.js` 展示状态。
- 同名 Java 测试类及 `core/test/library-index.test.mjs`：验证各边界；既有兼容测试继续使用。

## Task 1: 提取唯一集合校验实现

**Files:** 修改 `Library.java` 的 `prepareCollection`/`finishCollection` 调用；新建 `CollectionValidation.java`、`CollectionValidationTest.java`。

**Interfaces:** `CollectionValidation(RuleEngine engine)`；`Prepared prepare(JsonNode raw, String kind, Library.Extension extension, String id, Map<String,Library.Extension> available)`；`Result finish(Prepared prepared, Check cached, boolean externallyValidated, RuntimeException validationFailure)`。`Prepared(String id, String title, String description, String kind, Library.Extension extension, List<Library.Question> questions, BankFeatures features, String checkKey)`；`Check(List<List<Library.OutlineItem>> outlineItems)`；`Result(Library.Collection collection, Check successfulCheck)` 的成功检查可为空。将现有解析逻辑原样迁入，所需宿主引用/大纲工具仅扩大为包内可见，不公开 API。

- [ ] 写回归：非法重复 qid、Schema拒绝、开发容错、显式大纲、跨库相同 qid 各自标签；断言返回集合及错误代码不变。
- [ ] 在改动前执行新增测试，确认缺少新边界而失败；保存日志。
- [ ] 提取实现，并让旧批量目录把 `CatalogRuleValidation` 的结果传入 `finish`；不改规则分块或 VM 重置行为。
- [ ] 在 `core/` 执行 `mvn -Dtest=CollectionValidationTest,CatalogRuleValidationTest,BankOutlineTest,MixedDevelopmentBankTest test`；全部通过，原冷目录规则调用数量断言不变。
- [ ] 审查本任务增量并按全局约束保存提交或工作区证据。

## Task 2: 轻量索引

**Files:** 新建 `LibraryIndex.java`、`LibraryIndexTest.java`；修改 `Library.java` 接入索引。

**Interfaces:** `LibraryIndex(Path root, DevelopmentSettings settings)`；`Snapshot scan()`；`Snapshot(String revision, List<Candidate> candidates, ObjectNode catalog)`；`Candidate(String kind, String id, Path source, ObjectNode metadata)`。输出深复制 JSON，普通路径检查复用 `ExtensionDirectories`、`BankDirectories`、`Json.safeFile` 和 `LibraryManagement.catalog`。

- [ ] 写测试：`scanRunsNoRulesAndImportsNoResources` 断言规则跟踪调用为 0、资源目录未创建、合法行 status 为 `pending`；`invalidMetadataIsIsolated` 断言一个坏 JSON 不隐藏好库；覆盖空分组、开发开关、多个正式版本和混合引用。
- [ ] 执行 `mvn -Dtest=LibraryIndexTest test`，确认新接口未实现导致失败。
- [ ] 实现只读元数据扫描：题库 JSON 上限 8 MiB，声明上限 256 KiB，沿用现有题目数量和标识约束；不调用 `DevelopmentExtensions.read` 的完整修订扫描。保留所有候选给加载器，展示正式拓展最新版本并保留独立错误行。
- [ ] 相同扫描输入产生相同 revision；目录/声明/题库元数据和开发模式变化使 revision 改变。深层页面变化由目标加载的完整身份检查发现，不把 indexRevision 当作校验缓存键。
- [ ] 执行 `mvn -Dtest=LibraryIndexTest,ExtensionGroupsTest,LibraryManagementTest test`；全部通过；审查和保存增量。

## Task 3: 指定集合加载与结果发布

**Files:** 新建 `ScopedLibraryLoader.java`、`ScopedLibraryLoaderTest.java`；修改 `Library.java` 的 collection/page/development/developmentBank 读取路径。

**Interfaces:** `ScopedLibraryLoader(Library library, CollectionValidation validation)`；`Loaded load(LibraryIndex.Snapshot snapshot, String kind, String id)`；`Loaded(Library.Collection collection, Map<String,Library.Extension> extensions, Map<String,DevelopmentExtensions.Package> developmentPackages, ObjectNode descriptor, String sourceIdentity, ObjectNode catalogRow)`。`descriptor` 为所需页面/开发描述，`catalogRow` 含真实完整修订。`Library` 提供包内的现有扩展读取/页面构建工具，加载器的工作结果不得直接修改其共享 maps。

- [ ] 写测试：打开目标库的跟踪记录无无关题库数据；未读取无关拓展页面；正式/开发/混合/UI/扩展示例都可加载；`invalidEarlierDuplicateDoesNotClaimId` 保留首个成功候选规则。
- [ ] 执行 `mvn -Dtest=ScopedLibraryLoaderTest test`，确认尚未实现而失败。
- [ ] 从 Task 2 快照选目标候选，加载引用拓展、必要示例、SDK及资源，通过 Task 1 完成校验。跨版本拓展以实际身份绑定；开发描述只处理必要集合，不调用全库 refresh。
- [ ] 结果发布使用短锁与源身份复核。加载期间变更时最多重新获取快照加载一次，仍变更则返回 409 `LIBRARY_CHANGED`；旧结果不得进入共享 maps 或 ready 状态。
- [ ] 修改完整目录使用同一校验/加载结果，不在全局锁内等待规则；保留原批量规则优化作为完整目录的校验方式，保留错误行排序与重复 ID 语义。
- [ ] 执行 `mvn -Dtest=ScopedLibraryLoaderTest,CatalogRuleValidationTest,DevelopmentExtensionsTest,DevelopmentRuntimeWorkflowTest,MixedCollectionTest,MixedDevelopmentBankTest,BankFeaturesTest test`；全部通过；审查和保存增量。

## Task 4: 前台优先的后台协调与新路由

**Files:** 新建 `LibraryLoadCoordinator.java`、`LibraryLoadCoordinatorTest.java`；修改 `Library.java`、`QuizForgeServer.java`；增加 `LibraryIndexHttpTest.java`。

**Interfaces:** `LibraryLoadCoordinator implements AutoCloseable`；`Key(String kind, String id, String sourceIdentity)`；`CompletableFuture<ScopedLibraryLoader.Loaded> submit(Key key, Supplier<ScopedLibraryLoader.Loaded> load, boolean foreground)`；`void invalidate(Set<Key> current)`；`void close()`。`Library.index()` 返回带当前验证状态的深复制轻量 JSON；`Library.startBackgroundValidation()` 为当前索引排队尚未完成集合。

- [ ] 用 CountDownLatch 控制后台任务，测试它未释放时索引和另一个前台任务已完成；断言后台和前台各最多一个，相同 Key 只执行一次。失败任务不会永久占位，修改后新身份可重试。
- [ ] 写 HTTP 测试：新 GET 路由鉴权与 canManage 保持；旧 catalog 仍完整校验；开发关闭后不返回开发行；正在校验时删除/修改源和关闭服务不会提交旧 ready 或遗留执行器。
- [ ] 执行 `mvn -Dtest=LibraryLoadCoordinatorTest,LibraryIndexHttpTest test`，确认失败。
- [ ] 实现两条有限执行通道、共享任务表和短锁提交。后台任务不自动由每次 index GET 新建；首次前台加载成功或失败后调用 `startBackgroundValidation()`，依次排队当前 pending 集合。没有可打开题库时不启动规则，用户打开拓展示例后同样触发后台队列。未知来源身份必须先核实，不跨内容复用任务。
- [ ] 接入 `GET /api/library/index`，在服务 close 关闭协调器；所有原本 synchronized 的调用者也不得在持锁时等待 future。保留写入冲突与串行保证。
- [ ] 执行 `mvn -Dtest=LibraryLoadCoordinatorTest,LibraryIndexHttpTest,LibraryExportConcurrencyTest,ServerTest,LibraryManagementTest test`；全部通过；审查和保存增量。

## Task 5: 按资源内容复用导入

**Files:** 新建 `LibraryResourceImports.java`、`LibraryResourceImportsTest.java`；修改加载器和 `Library.java` 的导入调用。

**Interfaces:** `void ensure(ResourceStore store, Path directory, JsonNode declaredAssets, boolean extension)`；`void invalidate(Path directory)`。缓存身份含 store 实例/命名空间、目录及实际资源内容；缓存只代表对应内容地址目标仍存在且有效。

- [ ] 写测试：两个题库引用同一扩展仅执行一次导入；正常和开发 store 分开导入；源图片变更或内容地址目标丢失后重新导入；非法图片仍失败。
- [ ] 执行 `mvn -Dtest=LibraryResourceImportsTest test`，确认失败。
- [ ] 实现共享导入任务，保留现有路径/大小/类型/哈希检查；只读目录接口不使用此类，历史图片保留不变。
- [ ] 执行 `mvn -Dtest=LibraryResourceImportsTest,RichTextServiceTest,ScopedLibraryLoaderTest,LibraryArchiveTest test`；全部通过；审查和保存增量。

## Task 6: 成功校验的磁盘复用

**Files:** 新建 `ValidationCache.java`、`ValidationCacheTest.java`；修改 `CollectionValidation`/加载器的缓存接入及 `RuleEngine.java` 的环境身份读取。

**Interfaces:** `ValidationCache(Path root)`；`Optional<CollectionValidation.Check> read(String key, int questionCount)`；`void write(String key, CollectionValidation.Check check)`；`RuleEngine.validationEnvironment()` 返回 Node执行身份、runner及实际规则依赖代码的完整环境标识。内容键加入宿主校验协议常量 `quizforge-validation-v1`。

- [ ] 写测试：新实例复用成功记录，实际规则调用减少；改题库、规则、Schema、SDK、同版本依赖字节或 Node身份均使旧结果失效；开发容错/超时不产生正式成功记录。
- [ ] 覆盖损坏/不可写/符号链接缓存、outline数量/形状不合法、2 MiB/32 MiB/2,048条限制及并发写入。断言坏缓存被忽略且仍重新校验。
- [ ] 执行 `mvn -Dtest=ValidationCacheTest test`，确认失败。
- [ ] 实现有界读取、同目录临时写及原子替换；磁盘失败只放弃缓存。仅淘汰本缓存目录内可确认的普通缓存文件。环境指纹启动构建，关联文件变化后重新计算；重新核实资源与宿主检查后才能显示 ready。
- [ ] 执行 `mvn -Dtest=ValidationCacheTest,ScopedLibraryLoaderTest,CatalogRuleValidationTest,RuleEngineConcurrencyTest test`；全部通过；审查和保存增量。

## Task 7: 前端先显示目录并更新校验状态

**Files:** 新建 `core/web/library-index-client.js`、`core/test/library-index.test.mjs`；修改 `app.js`、`views/library-view.js`，必要时修改已有状态样式。

**Interfaces:** `createLibraryIndexClient({request,onIndex,onError,isVisible,setTimer,clearTimer})` 返回 `refresh()`、`visibilityChanged()`、`stop()`；`refresh()` 返回 Promise<index>。app 负责首次首库打开与缓存管理，客户端只读取并交付目录，不导航。

- [ ] jsdom/fake timer 测试：pending/checking行显示“待校验”/“校验中”并可点击；错误行提示错误；首次列表渲染早于打开 Promise完成；每 2,000 ms 更新且全部完成停止。
- [ ] 测试隐藏/卸载停止、恢复可见后继续、登录重试与手动刷新产生新代次，旧 Promise结果被忽略。更新状态不调用 openCollection、不清空问题/页面缓存、不修改编辑输入；缺失 contentRevision 不冒充有效修订。
- [ ] 在 `core/` 执行 `node --test test/library-index.test.mjs`，确认失败。
- [ ] 接入轻量接口与轮询；保留 devsettings开关、刷新按钮、导入/目录管理、首库自动打开和401登录行为。首次所选集合可能仍需规则校验，其集合/开发描述请求使用现有 request 的 `timeoutMs:60000`，加载状态保持可见；目录轮询使用原默认请求时限。打开失败将最新错误同步行状态，其他题库仍可点击。
- [ ] 执行 `node --test test/library-index.test.mjs test/extension-groups.test.mjs test/library-management.test.mjs test/library-transfer.test.mjs test/collection-navigation-host.test.mjs test/save-recovery.test.mjs`；全部通过；审查和保存增量。

## Task 8: 兼容验证、整页计时和交付

**Files:** 更新 `core/server/README.md`、`core/docs/CORE_SOURCE.md`、`core/docs/CATALOG_STARTUP_PERFORMANCE_2026-10-11.md`；基于 `.temp/startup-performance-20261011/prepare_page_probe.py` 新建仅隔离使用的测量脚本/证据目录。

- [ ] 执行前核对产品现有进程及数据快照；使用独立构建输出与临时 JAR，不覆盖运行服务使用的 JAR。测量副本只复制既定题库/扩展和开发开关，不复制答案、AI凭据或网络配置。
- [ ] 执行 Tasks 1–6 的 Java 回归并覆盖 Server、编辑、导入、发布、历史、考试的必要路径；执行 `node --test test/*.test.mjs server/*.test.cjs`，记录实际通过数、失败和耗时。失败先修复相关改动，之后只重跑必要验证。
- [ ] 使用 Java 25.0.4.1、相同源数据快照与新浏览器页面，完成三次独立冷启动及三次带成功缓存的重启；测量期间不并行重型测试。每次保存 API时长、列表DOM、首题就绪、前后台规则调用和所有原始数据。
- [ ] 报告中位数/范围，2秒目标是否达到及剩余首题耗时。通过实际页面验证 pending→ready/error、首库加载和第二库点击；帧回调不标为屏幕绘制时间。
- [ ] 仅关闭本次创建的准确临时进程与标签。文档说明新目录契约、校验缓存失效/界限、验证范围和用户启动方式；对全部任务增量做完整审查后交付，不把既有测试结果当成修改后的证据。

## 自检与执行交接

Tasks 1–3 保留唯一校验实现及按需读取，Task 4 验证锁/去重/过期提交，Tasks 5–6 覆盖复用与失效，Task 7 覆盖前端状态，Task 8 给出整页证据。五项 Review Focus 均有归属测试；全部新方法的输入/输出已定义，性能目标没有替代实测。

推荐 Native：由当前会话逐项实现，原因是既有 Library 的加载、发布和失效调用相互依赖，统一改动更容易控制用户已有工作区的边界；实现后按技能要求进行独立最终审查。另一选项是 Subagent-driven：每个任务交由独立子代理实现与审查，上下文及协调成本更高。

本计划等待用户审阅并选择执行方式；该确认完成前不改动产品代码。

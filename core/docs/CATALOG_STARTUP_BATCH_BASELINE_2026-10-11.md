# 首次题库目录加载优化（2026-10-11）

首次进入时，浏览器等待 `/api/catalog` 返回后才渲染题库列表。主要耗时来自冷目录扫描中重复启动 Node 规则进程：每个题库按题型分别执行校验。同一种题型出现在多个题库时，仍分别启动进程。

**复核更正：7.5 秒仅为 Java 21 环境下 `Library.catalog()` 的一次隔离计时，不能代表实际网页首次加载。当前运行的优化版服务使用 Java 25.0.4.1；同版本、同数据的新服务副本实测目录请求 18.7 秒、列表 DOM 完成 19.5 秒、首题就绪 25.7 秒。优化代码已生效，但实际冷启动仍明显缓慢。**

## 实现

- `Library` 将扫描拆为宿主准备、规则校验、逐集合应用结果；拓展示例先完成校验，再处理题库。
- `CatalogRuleValidation` 合并同一拓展身份、版本、内容签名、目录及运行模式的题目，调用原有 `RuleBatches.validate`。
- 沿用原有 512 题、512 KiB 分块目标、规则超时和沙箱。仍校验全部题目，未跳过 Schema 或题型规则。
- 合并进程内以宿主提供的 `contextResetOffsets` 保留原集合及原分块的 VM 重置边界，避免拓展全局或闭包状态跨题库传播；不拆开原分块来填满合批请求。旧请求不带该字段时行为不变，拓展接口不变。
- 合批失败后，按原集合的该题型回退校验，正常题库继续可用；保留原有首个错误及开发版容错。
- 大纲继续逐集合生成，避免不同题库的相同题目 ID 互相覆盖。重复题库 ID 按原扫描顺序处理，坏集合不占用 ID。
- 成功校验缓存和修改失效逻辑沿用原实现；直接编辑、导入仍完整校验。

## Java 21 函数级隔离测量

使用当前题库和拓展的副本：17 个题库、153 题、9 个开发版拓展，开发者模式开启。前后数据字节及修改时间完全一致，不复制用户作答或模型凭据。每个变体使用独立 JVM、空目录缓存及独立资源状态；测量范围为 `Library.catalog()`，不包含浏览器首题渲染。

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 冷目录加载 | 33,166.72 ms | 7,489.43 ms |
| `validateBank` 进程调用 | 94 | 16 |
| 规则调用累计耗时 | 30,979.29 ms | 5,328.80 ms |
| 热目录刷新 | 132.69 ms | 116.65 ms |
| 热刷新规则调用 | 0 | 0 |
| 目录错误 | 0 | 0 |

本次冷目录耗时减少 77.42%，约快 4.43 倍。前后完整目录 JSON 的字段、数组顺序和值一致，序列化字节也一致（SHA-256：`fdcf3b3afa0e5f12611c99d8342b99f938639db63d36c954cd8b4c31a59a1d32`）。这些数字来自一次正式前后对照，不代表多次统计结果或完整页面端到端耗时。最终源码与 `after-isolated/` 计时快照的 41 个 Java 源文件 SHA-256 全部一致。

证据位于产品根目录 `.temp/startup-performance-20261011/`：`comparison.json`、`before/timing.json`、`after-isolated/timing.json`、前后 `catalog-cold.json` 和 `source-sha256.json`。计时包装只在隔离源码副本中加入。最终 runner SHA-256：`194710dd53123e1a519ca37a34a883cfb8ab01adad0dd5a099cc5837ca3fd550`。

## 按当前运行版本复核完整网页

用户反馈首次进入仍需十多秒后，检查到本机服务启动于 13:31:32，使用 13:31:31 构建的 JAR；JAR 中的 `Library`、`CatalogRuleValidation`、`RuleBatches` 与当前构建类字节一致。当前题库和拓展的数据字节也与原隔离基线一致，因此不能将等待归因于旧版本或题库增加。

使用该 JAR 的独立副本、与运行服务相同的 Java 25.0.4.1、相同题库/拓展字节、空资源状态及新浏览器页面进行复核。只复制开发者模式布尔开关，没有复制用户作答、模型凭据或网络设置。计时代码只放入副本的 HTML 和 app.js，使用浏览器 Performance 记录请求及启动阶段。

| 完整网页阶段 | 耗时／时点 |
| --- | ---: |
| app.js 开始执行（相对导航开始） | 770.5 ms |
| `/api/catalog` 请求耗时 | 18,678.2 ms |
| `/api/settings/development` 请求耗时 | 28.0 ms |
| 列表 DOM 完成（相对导航开始） | 19,465.3 ms |
| 首题就绪（相对导航开始） | 25,684.9 ms |

列表请求之后，开发题库描述、集合状态和首题请求分别约 1.54 秒、2.50 秒及 1.76 秒；它们继续影响首题可用时间，但不是列表生成前的主等待。后台浏览器双 requestAnimationFrame 时点为 20,046.0 ms，仅作为参考帧时点，不代表前台屏幕像素测量。

另一次使用 Java 25、直接调用 `Library.catalog()` 的冷目录结果为 16,387.52 ms、16 次规则调用累计 10,587.79 ms，热刷新 937.18 ms。这说明原 7.5 秒不是当前环境下稳定可复现的加载时间；不同 JVM、测量路径、文件系统和当时机器负载均未作充分控制，不能仅凭这些单次结果认定差额由某一个因素造成，也不能声称完整页面加速 77%。已确认本次网页主要等待仍在目录请求。

补充证据：`.temp/startup-performance-20261011/page-probe/browser-timing.json`、`page-probe/setup.json`、`after-java25/timing.json`。测量后关闭了创建的两个浏览器标签及独立副本服务；没有停止或重启用户的实际服务。

## 验证与启用

新增回归覆盖冷目录合批调用、热缓存、内容和规则修改后重验、坏题库隔离及修复、跨库重复题目 ID 大纲、重复题库 ID、512 题及 512 KiB 分块，以及有状态校验器的跨集合隔离和原分块内状态保留。

- 规则运行器：`node --test server/rules-runner.test.cjs`，30 项全部通过。
- Java 21 定向回归：63 项通过，0 失败、0 错误、0 跳过；覆盖 `CatalogRuleValidationTest`、`LibraryManagementTest`、`BankOutlineTest`、`DevelopmentExtensionsTest`、`DevelopmentRuntimeWorkflowTest`、`MixedCollectionTest`、`MixedDevelopmentBankTest`、`ExtensionGroupsTest`、`BankFeaturesTest` 及 `ServerTest` 的目录、题目缓存、同版本规则变更和绑定元数据相关 6 个方法。
- 日志：`.temp/startup-performance-20261011/runner-tests.log`、`java-tests.log`；最终源码核对：`after-isolated/final-source-verification.json`。

以上是这次优化的定向回归，没有将此前全量测试结果当作本次修改后的全量回归。

这次工作没有重启现有服务，也没有改写用户题库或作答状态。保存作答、关闭原启动窗口后，重新运行产品根目录的 `Start-QuizForge-Web.cmd`；启动脚本会按 Java 源码变更重新构建，新的服务才会使用优化。不要使用 `-SkipBuild`。

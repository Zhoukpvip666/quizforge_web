# Windows 桌面启动器

`windows/` 是轻量 Windows Forms 托盘启动器源码。业务、数据存储、规则执行及网页仍由 Node 后端负责；用户入口是产品根目录的 `QuizForge.exe`，不新增网页窗口外壳。

需要 Windows 10/11 x64、系统 .NET Framework 4.8。构建使用 Windows Framework 自带 `csc.exe`，无需安装 .NET SDK。源码运行可查找系统 Node.js 24；预览包优先使用 `runtime/node.exe`，不需要全局 Node。

在产品根目录构建：

```powershell
& ./core/scripts/build/build-windows-launcher.ps1
node ./core/scripts/build/build-windows-preview.mjs
node ./core/scripts/build/build-windows-installer.mjs --compiler "C:/tools/Inno Setup 7/ISCC.exe"
```

EXE 输出到根目录；ZIP 输出到 `dist/`，已有同版本文件时拒绝覆盖。可用 `--output` 指定另一输出目录，`--version` 指定发布版本，`--node` 指定 Node.js 24 可执行文件，`--node-license` 提供该版本的本地 LICENSE 以离线构建；未提供 LICENSE 时从 Node 官方仓库对应版本下载。正式发布时从已提交源码构建，用 `--source-commit` 将40位提交摘要写入 RELEASE.json；本地未提交构建默认留空，不声称对应当前 Git 提交。依赖复制自当前 `core/node_modules`，保留许可证，不在打包时升级版本。

安装版同样输出到 `dist/`，文件名以 `-setup.exe` 结尾，并生成 SHA-256 文件。构建需要 Inno Setup 7.1（含简体中文语言文件）；使用 `--compiler` 或 `ISCC_PATH` 指定编译器。源码配置在 `installer/`，两种包共用 `scripts/build/stage-windows-app.mjs`，不复制个人数据。`--launcher` 可指定在隔离位置构建的新 EXE，避免覆盖正在运行的开发启动器。

安装器以当前用户权限安装到 `%LOCALAPPDATA%/Programs/QuizForge`，自动创建桌面及开始菜单快捷方式，完成页默认勾选打开应用。升级和卸载前检查安装版互斥量，要求用户先保存并退出托盘，不自动停止服务。安装器拒绝把源码、解压版或用户数据目录作为程序目标。只有程序目录内的 `core/`、`runtime/`、`defaults/`、`skills/` 会在升级时更新；卸载保留数据。

安装器同时注册当前用户的 `.qbank` 文件类型、图标和打开命令 `"QuizForge.exe" --import "%1"`。没有已有默认打开程序时将其指向 QuizForge；已有选择保持不变，用户可通过 Windows“打开方式”选择 QuizForge。不改受保护的 UserChoice。卸载只移除本应用的 ProgID／打开方式项；仅当扩展名默认值仍属于本应用时清除该值。注册和刷新流程遵循 [Inno Setup 文件关联说明](https://jrsoftware.org/isfaq.php#assoc)。ZIP 不主动注册系统关联，可把 `.qbank` 拖到新版 EXE 或通过参数打开。

`--import <本机.qbank>` 和单个位置参数均支持中文、空格及引号转义。文件必须存在、非空且不超过 64 MiB；拒绝网络 UNC 路径，先下载到本机。已有托盘通过仅当前用户可访问的管道接收任务，新启动则等待后端就绪。原生端以流上传到现有 `/api/library/import`，继续执行格式、路径、资源和规则校验，不增加 HTTP 本机任意路径读取接口。任务按顺序处理，同一文件尚在队列中时重复打开合并；完成后再次打开按原规则新增独立副本。原文件及已有题库／进度不修改。

导入进度和失败原因显示在托盘通知、运行情况和 `--status` 的 `pendingImports`／`lastImport` 中。成功时打开新网页并通过 `imported-bank` 提示选中新题库，已有答题页面保持原样；提示只携带已安装题库的路由 ID，网页验证目录中存在后消费提示，刷新不再次导入。首次由题库文件启动时只在完成后打开一次网页。正常退出等待已经接收的导入完成，再关闭后端。`--no-browser` 测试模式仍记录目标地址与打开计数，但不实际打开浏览器或弹导入通知。

Hub 一键导入本地端遵循 `hub-local-import-v1` 对接文档（Hub 分支 `docs/hub-local-import-v1`，格式要求修订 `2205cbd`）。安装器在 HKCU 注册 `quizforge` URL Protocol，命令为 `"QuizForge.exe" --open-url "%1"`；遇到其他程序或其他安装位置占用时保留并提示，升级／卸载只更新或移除仍指向本安装位置的协议。源码和 ZIP 不自动注册。

唯一链接形式为 `quizforge://hub/import?v=1&pack=<小写 UUID>&revision=<正整数>`，字段顺序不限。原始字符串最多 1024 字符，仅接受恰好各一次的三个字段；拒绝编码、未知字段、空白、引号、用户信息、端口和 fragment。revision 不带前导零，最大 9007199254740991。`--open-url` 只允许这两个参数，不能混用目录、文件或控制参数。已有实例的 `hub-import` 消息由发送和接收两端校验，继续使用当前用户管道。

客户端只请求固定 `https://quizforge.treenewbee.cloud` 的 `/api/packs/<id>/local-import?revision=<revision>` 和 `/api/packs/<id>/download?revision=<revision>&sha256=<sha256>`。清单最多 32 KiB，校验 schemaVersion、题库身份、revision、文件类型、大小和 SHA-256。系统 TLS 与证书校验保持开启，不跟随重定向、不使用代理或传递 cookie／默认凭据；清单和下载共用 180 秒期限，无自动重试。下载流写入实际数据目录 `.temp/hub-import-v1/<随机任务>/package.qbank`，同时计算摘要，严格匹配 Content-Length、实际长度与 64 MiB 上限；通过后复用本机上传接口。不传固定暂存文件名给宿主，安装名称由包内清单决定，远端名称仅显示。格式 3 单库和分组包均可用；格式 1、2 仍拒绝并提示制作者升级。

Hub 与本机文件共用串行队列、20 个待处理任务上限；同 pack/revision 尚在队列中时合并，完成后再点生成独立副本，不覆盖已有题库。Hub 状态为 queued/downloading/importing/completed/failed，`lastImport` 补充 source、packId、revision。运行情况动态显示进度；成功在新网页选中新题库，旧答题页不刷新。成功失败均清理本任务，清理失败记录状态及 `logs/hub-import.log`；下一次后端就绪时只处理专用目录中超过 24 小时的已知任务，不递归删除未知文件或链接目录。

本地实现不代表 Hub 入口已启用。Hub 服务、能力开关、网页按钮由 Hub 项目独立交付；兼容安装包可用、两端部署且真实浏览器冷／热启动验收通过后再开启入口。旧 Hub 明确失败并提示下载文件，不自动切换题库版本。

`INSTALLATION.json` 标记安装布局。安装版数据默认在 `%LOCALAPPDATA%/QuizForge`；基础题库及四个拓展放在程序 `defaults/`，首次启动在持有数据锁后复制。`.state/initial-content.json` 记录首次初始化；以后升级不合并模板、不覆盖或补回用户修改/删除的内容。中断通过同目录 pending 日志恢复，发现外部冲突时保留原件并报错。已有非空数据目录不会注入基础内容。旧解压版不自动迁移，用户可先导出 `.qbank`，再在安装版导入；搬运完整记录须停服后备份整个数据目录，不只移动题库。

发布包按名单包含后端、网页、富文本 SDK、运行依赖、技能和文档、基础题型展示库及四种基础拓展。排除根目录人工测试、自动测试、开发启动脚本、其他题库/拓展、个人 `.state`、临时及回收数据。`RELEASE.json` 记录版本、Node 版本、托盘摘要和依赖列表；生成的二进制及 ZIP 不提交 Git。

源码目录（有 `core/package-lock.json`、没有 `RELEASE.json`）启动时，后端在加载第三方包之前对照锁文件与 `core/node_modules/.package-lock.json`；不一致则不启动，并经 `--desktop` 标准输出的 `failed` 消息把“缺少依赖或版本不符：包名。请在应用根目录运行 npm --prefix core ci 后重新启动。”交给托盘状态、“运行情况”和通知。托盘没有控制台窗口，`npm ci` 会重建 `node_modules` 且可能需要联网，因此托盘只提示命令，不自动安装；`Start-QuizForge-Web.cmd` 在可见窗口中自动运行 `npm ci`。预览包不做锁文件比对、不运行 npm；模块加载失败时提示缺少的包名并要求重新解压。原因只含包名或文件名，不含完整路径。

正常首次启动等待后端专用标准输出 ready 消息后才打开浏览器。左键打开网页；右键提供状态、运行情况、打开数据文件夹和退出。进程内按实际数据目录防重复，第二个 EXE 通过仅当前 Windows 用户可访问的命名管道请求原托盘打开网页。`--root` 指定程序根目录；`--data-root` 显式覆盖数据目录，安装版要求它位于程序目录之外。没有安装标记时，两者默认相同。`--port`、`--no-browser` 用于隔离验证；`--layout` 只读输出布局而不启动服务或创建数据目录；`--status` 输出托盘状态 JSON，含程序和数据目录，`--quit` 请求原托盘退出。Node 入口接受 `--root`（数据根）、`--code-root`（core 目录）和 `--initial-content`（首次模板），原源码启动命令保持不变。

后端 `--desktop` 只监听父进程专用 stdin 的 `quit` 或 EOF，不注册 HTTP 关闭路由。正常退出停止接收新请求，等待已接收的 HTTP 请求与数据事务，再关闭规则、AI、服务及目录锁；尚在浏览器中且未发出的输入仍需用户确认已保存。Windows Job Object 管理自己启动的进程树，托盘异常结束时回收后台进程。其他启动方式的现存服务不会被自动接管或终止。

自动验证：`node --test core/test/desktop/windows-tray.test.mjs`（Windows x64）覆盖启动、单实例、本地单库／整组文件、重复导入、损坏和超限文件、退出等待及原答案保留；网页路由提示见 `test/library/native-import.test.mjs`。后端控制及保存退出检查在 `server/host/http/desktop-control.test.mjs`、`server.test.mjs`；依赖检查与失败原因在 `server/host/platform/dependencies.test.mjs`。这些流程验证不能代替托盘真实鼠标点击、系统默认浏览器打开和原生窗口人工验收。

`node --test core/test/desktop/hub-import.test.mjs` 覆盖 URI／参数／管道、固定版本下载错误、长度与摘要、时限、暂存清理、冷／热启动、混合队列、旧格式拒绝和退出等待。独立 C# 测试入口通过内部构造参数使用本机 HTTP 服务；该入口不编进产品，正式 EXE 没有命令行或环境变量服务器覆盖。测试不访问线上 Hub 或真实协议关联。

安装、升级及卸载专项需显式运行：`node core/scripts/test/verify-windows-installer.mjs --compiler <ISCC.exe> --payload <安装版暂存目录>`。它编译独立 AppId/名称、专用测试扩展名和 URI scheme 的安装器，在 `.temp/` 安装程序及数据，验证快捷方式、文件关联、URI 引号及占用保护、真实原生文件导入和 HTTP 作答、运行时升级拦截、保留数据及卸载后清理自己的注册项和快捷方式；不改系统真实 `.qbank`／`quizforge` 关联，不自动安装正式 QuizForge，也不访问其数据目录。构建参数 `--test-id` 同样隔离上述三类标识。

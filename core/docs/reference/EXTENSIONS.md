# 拓展开发

完整页面、规则与 HTTP 接口见 [API 文档](API.md)。一个独立拓展提供一个题型和一本只引用自身的样例题库；组合题内部小问由该大题型统一管理。

## 文件与分组

```text
extensions/
  基础题型/                 # 一层物理分组，可省略
    my-type/                # 独立拓展叶目录
      manifest.json
      development.json      # 仅开发版保留
      examples.json
      practice.html
      practice.js
      practice.css
      rules.js
      question.schema.json
      answer.schema.json
      editor.json           # 可选编辑器声明
      editor.*
```

Manifest 声明 ID、精确版本、名称及页面、规则、Schema、样例路径；具体字段见实现契约。路径均相对于叶目录，禁止符号链接、越界路径或读取其他拓展。遇到 manifest 或开发标记即停止向下扫描，叶内可以组织源码和资源目录。

分组只负责目录及列表展示，没有清单、ID 或共同版本；只支持一层分组，不能移入其他分组。扫描上限为 1000 个目录节点、200 个叶拓展，分组内普通说明文件忽略。移动完整叶目录并保持身份与内容不变，不改变题库绑定。开发叶名在全部分组中必须唯一。

不支持 `manifest.types`、`packageFormatVersion` 或绑定 `typeId`；不能用 `data.kind` 切换多个独立题型。

## 绑定、样例与资源

正式题库精确绑定 `{"id":"quizforge.my-type","version":"1.0.0"}`；测试题库使用 `{"development":"my-type"}`。绑定不含分组路径，一本题库可混用多个正式或开发拓展。开发者模式控制拓展列表可见性，不改变正式题库绑定。

`examples` 使用[题库格式](QUESTION_BANK_FORMAT.md)，题库 ID 为 `examples`，仅精确绑定自身 Manifest 的 ID/版本，可包含多道同题型变体。可用 `examples.json`，或 `examples/bank.json` 与相邻 `assets/`。样例与普通题库共用练习、编辑和保存管线，状态独立。功能开关默认全部开启。

页面静态图片、字体通过 `manifest.assets` 声明，支持 PNG/JPEG/WebP/GIF/SVG、WOFF/WOFF2/TTF/OTF，最多 100 项、每项 1 MiB、合计 8 MiB。动态答案图片使用 `QF.resources` 的内容哈希资源；富文本使用[公共服务](RICHTEXT_SERVICE.md)，不复制编辑器实现。

## 开发版

添加普通对象 `development.json`，如 `{}` 或 `{"name":"我的题型 · 开发版"}`。开发版与正式版共用 QF 页面、规则、编辑和保存管线，额外提供开发标签、当前页面热刷新及 `.development/.state/` 测试数据隔离。

可以先接入 `QF.page.register({onLoad})` 与真实公开投影，再补齐规则、Schema 和编辑器。尚未实现的动作应省略或抛出 `code:"DEVELOPMENT_NOT_IMPLEMENTED"`，不能返回虚假的保存或评分成功。热刷新与保存失败均应保留输入。`history:false` 时测试作答仅在页面会话内，编辑题目仍可保存。

混合开发题库逐题使用各自拓展的页面和规则，源文件变化只重置受影响题目的当前作答，冻结历史保留。旧 `mode:"ui"/"runtime"` 及 marker 中的文件声明仅兼容读取；新拓展使用 Manifest 与普通 QF 接口。

## 校验与发布

在产品根目录运行只读校验器：

```powershell
node skills/quizforge-bank-builder/scripts/validate-bank.mjs --project . --bank question-banks/my-bank/bank.json
```

开发绑定添加 `--allow-development`。未完成骨架可另加 `--preview-only`，仅检查结构、声明、资源及已有 Schema，不执行评分规则；预览通过不代表功能完整。完整发布验证还需覆盖实际作答、提交、评分、编辑保存、切题、只读历史、上传及资源释放。

更新已发布代码时复制到新的唯一开发叶并采用新版本；旧包保留。完整校验后人工移除 `development.json`，确认 Manifest 声明完整、样例精确自绑定，再执行正式校验。当前无发布按钮；发布不会自动迁移已有题库绑定。同 ID/版本不能出现不同代码。受控样例编辑仅修改题目及专属图片，不修改版本代码，详见[兼容说明](COMPATIBILITY.md)。

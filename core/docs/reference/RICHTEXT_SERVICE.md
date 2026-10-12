# 富文本服务

拓展通过 `QF.content` 使用公共接口。宿主选择编辑器实现并管理组件版本；当前使用 Tiptap，拓展不依赖其 npm 版本或内部实例。

## 声明与文档约定

```json
"requiresRichText": {
  "major": 1,
  "minMinor": 1,
  "documentFormat": 1,
  "documentProfile": "advanced-v1",
  "capabilities": ["images", "tables", "math", "camera-capture"]
}
```

前四项必填，capabilities 可省略或为空。能力为不重复的已支持字符串，未知字段、版本、格式或约定拒绝；不能同时声明旧 dependencies。不使用富文本时可省略。

当前接口为 1.1，兼容 1.0；文档格式为 1。

| 文档约定 | 内容与能力 |
| --- | --- |
| `basic-v1` | 段落、标题、列表、引用、代码、链接、图片；basic-formatting、images |
| `advanced-v1` | 基础内容及字体、字号、颜色、高亮、上下标、段落布局、表格、公式、图片布局；另有 advanced-formatting、tables、math、image-resize、camera-capture |

能力声明不限制该约定的文档节点子集；Schema、规则及编辑草稿须支持完整的所选约定。不兼容的新节点需新的文档约定，不能改变同名约定含义。

## 公共接口

`QF.content.api` 提供只读 `{major,minor,documentFormat,documentProfile,capabilities}`，未登记约定的旧精确依赖为 null。

- 文档方法：`render/createEditor/validateDocument/cloneDocument/isEmpty/fromEditorDocument` 及文档常量。
- 编辑器句柄：`ready/getDocument/setDocument/focus/flush/isUploading/destroy`。
- 高级约定：`setAdvanced/isAdvanced`；1.1 的 camera-capture 增加 `capturePhoto()`。

保存 QuizForge 文档 JSON 与图片 assetId，不保存任意 HTML、Blob URL、Tiptap 实例或私有状态。不要调用 `QFRichText/configure/_createEditor` 等内部实现。题型校验、评分和 AI 材料转换仍由拓展负责。

## 拍照作为答案图片

使用高级编辑器的内置拍照入口，手机以 `input[type=file] capture="environment"` 请求后置摄像头，实际界面由系统与浏览器决定；桌面通常显示文件选择器。自定义按钮须声明 minMinor:1、advanced-v1 及 camera-capture：

```js
const editor = QF.content.createEditor(answerHost, {
  doc: answerDoc,
  onChange(doc) { answerDoc = doc; scheduleDraft(); }
});
await editor.ready;
photoButton.onclick = () => editor.capturePhoto();
// 提交、切题或释放前：
await editor.flush();
```

capturePhoto 必须直接在点击事件中同步调用，先等 ready 再启用按钮。返回 true 表示已请求选择器；处理/上传中返回 false，未就绪或已销毁抛错。返回值不代表照片已保存，取消不改文档，处理完成通过 onChange 插入光标位置。

输入最多 20 MiB、4000 万像素且须可解码。较大照片按方向信息解码，缩至最长边 2560px 并压成不超过 4 MiB 的 JPEG；满足输出限制的 JPEG/PNG/WebP 保留原文件。处理及上传计入 isUploading/flush，失败提示并保留原答案，flush 拒绝直到成功重试；切换文档或销毁后丢弃旧回调。

照片成为普通 image 节点，只保存 assetId，沿用图片显示、删除、历史与 AI 转换。AI 识别仍要求模型具备视觉能力。

## 实现选择、兼容与维护

`core/shared/richtext/service.json` 登记验证过的实现与旧依赖映射：当前 basic-v1 使用 1.0.0，advanced-v1 使用 1.1.3。新拓展只声明公共约定。

`core/shared/richtext/` 只保留上述两种约定的当前实现。基础 1.0.0 与高级 1.1.3 支持不同文档范围，不能直接替换；旧高级实现不作为当前运行包。兼容测试所需的少量旧文件位于 `core/test/fixtures/legacy-richtext/`，不参与运行服务选择。

旧 `quizforge.richtext@1.0.0` 保留基础实现；1.1.0–1.1.3 的当前页面按已登记高级映射选择实现，未知旧版本按精确依赖读取。服务更新只改变页面资源版本，不改题目内容身份、答案、笔迹或编辑草稿。历史冻结实际组件版本与接口元数据，读取时不经过当前映射；所需组件固定保存于 `.state/sdk/`。

组件同版本不可原地重建。新版本准备 src 与 richtext.css 后，在 core 执行 `npm run build:richtext-advanced -- --version <新版本>`，基础组件用 build:richtext。构建只处理组件，已存在输出拒绝覆盖。

选择新实现前分别验证基础/高级文档的渲染、编辑保存、草稿恢复、图片、评分、AI 输入及旧历史重启恢复。公共接口和约定不变的组件修复无需升级拓展；题型行为或数据变化才发布新的拓展版本。

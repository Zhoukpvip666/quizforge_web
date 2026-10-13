# 独立拓展、分组与开发

一题型一独立叶拓展、一本同题型样例。不同独立作答／判分流程分别建叶；组合题可在一个父题内包含不同小问控件，仍由父题管理。禁止 `manifest.types`、`packageFormatVersion`、`typeId`、组身份／版本，或用 `data.kind` 假注册多个独立题型；合法组合题可用私有字段表示内部结构。

## 分组与绑定

```text
extensions/
  我的英语题型/                 # 物理分组，无 manifest 或开发标记
    choice/                    # 独立叶目录
      manifest.json
      practice.html / practice.js / practice.css
      rules.js / question.schema.json / answer.schema.json
      editor.json / editor.html / editor.js
      examples/bank.json
      examples/assets/         # 必要时
    reading/               # 另一独立题型
      ...
  single-choice/               # 根层叶目录也支持
    manifest.json
```

题库和拓展只支持一层分组，禁止分组嵌套；拓展叶深度最多二，1000 个目录节点／200 个叶。发现 `manifest.json` 或 `development.json` 即为叶并停止下探；分组不放标记、规则、混合样例或共同版本，普通 README／说明图片不参与发现。文件声明相对本叶，不能用 `../` 访问其他叶。

统一绑定为精确 {id,version}，旧development叶名绑定只用于兼容读取；分组不参与身份，允许跨组复用。

## 基础题型与已有样例

源码和已有样例统一在产品的 [单选题](../../../extensions/基础题型/single-choice-richtext) 与 [简答题](../../../extensions/基础题型/short-answer-richtext) 基础拓展中。先读 manifest/schema/rules 及声明的 examples，不再维护技能内 scaffold 或最小混合题库。基础题型按精确ID/version复用；仅在用户授权范围内修改，更新前备份并保持答案结构兼容。

复用现有叶不新建样例；确需新题型且已获许可时复制合适叶到授权目录，赋予独立身份，维护复制过来的 examples 并改为新叶精确自绑定。不得让新叶跨目录引用参考样例或修改原基础叶。

## 从 UI 到真实功能

完成 SKILL.md 的设计许可和 UI 访谈概要确认后才制作原型，在同一获准叶目录迭代。管理入口开关只影响入口，Agent 不改设置。

新叶写 `development.json:{}`，从普通 manifest、`QF.page.register`、公开 `project`、`getScore` 返回的真实 `maxScore` 及少量代表题开始。manifest 计划 ID／版本和文件声明见 [API](extension-api.md#清单与公共服务声明)。未完成规则／Schema可做显示预览，但真实提交、评分、保存、编辑必须显式报 `DEVELOPMENT_NOT_IMPLEMENTED`，不能伪造成功；本地演示按 UI 文档标注。UI 获准后补齐同叶规则、Schema、编辑器及公共接口，处理 flush/dispose 和失败。

显示骨架用 `--allow-development --preview-only`，仅预览结构；完整检查只加 `--allow-development`，缺业务实现仍失败。校验、实际功能验收与整库生成的确认条件只按 SKILL.md。旧标记中 entry/script/style/examples/editor/assets 仅只读补缺兼容，manifest 优先，不为新叶创建旧协议。

## 每叶一本样例

`manifest.examples` 指向普通题库格式的 UTF-8 JSON，ID 为 `examples`；可含多道同题型变体，所有有效绑定必须精确自引用本叶Manifest ID／版本。不能引用同组其他叶、用开发绑定替代样例自绑定或建组级混合样例；旧叶名绑定仅兼容读取，新绑定统一使用 ID/version。图片在相邻 assets，用内容哈希引用，格式见 [题库](bank-format.md)。

新样例一律省略 features 或四项 true，免问；已有显式 false 可读，validator 仅警告 `EXAMPLE_FEATURES_SHOULD_BE_ENABLED`。样例和普通题库共用切题、编辑、大纲、白板及历史流程，状态独立。编辑开启时宿主可受控修改样例数据及专属图片，不修改版本代码；功能开关的持久化语义只见题库文档。

## 统一状态（2026-10-13 起）

以下新约定替代本文旧开发／发布流程：题库与拓展没有开发版和正式版区分，不需要发布、复制版本或 development.json。可在用户授权范围内原位修改，先备份并保持答案结构和稳定ID兼容。ID/version/API仍保留；旧叶名绑定与标记仅兼容读取。新题库精确绑定ID/version，导出按分组收集全部相关拓展，与状态无关。

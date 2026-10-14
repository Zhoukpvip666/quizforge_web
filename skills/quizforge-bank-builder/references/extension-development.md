# 独立拓展、分组与开发

一题型一独立叶拓展、一本同题型样例。不同独立作答／判分流程分别建叶；组合题可在一个父题内包含不同小问控件，仍由父题管理。禁止 `manifest.types`、`packageFormatVersion`、`typeId`、组身份／版本，或用 `data.kind` 假注册多个独立题型；合法组合题可用私有字段表示内部结构。

## 分组与绑定

```text
extensions/
  choice/                      # 独立拓展目录，直接位于 extensions 下
    manifest.json
    practice.html / practice.js / practice.css
    rules.js / question.schema.json / answer.schema.json
    editor.json / editor.html / editor.js
    examples/bank.json
    examples/assets/           # 必要时
  reading/                     # 另一独立拓展，同样直接位于 extensions 下
    ...
```

题库支持一层物理分组，拓展没有物理分组，不创建 `extensions/<分组>/<拓展>/`。拓展仍有独立目录，文件声明相对本叶，不能用 `../` 访问其他叶。旧物理分组仅兼容读取，不在制作题库时擅自搬动。

拓展界面的逻辑分组记录在数据根目录 `.state/extension-groups.json`，结构为 `{schemaVersion:1,groups:[{id,name,members}]}`：`id` 是分组 UUID，`name` 是显示名称，`members` 是 `extensions/<实际目录>` 路径数组。没有成员关系的拓展显示为未分组；首次通过应用管理分组时创建记录表。表只用于本地界面，不参与题库绑定、拓展身份或内容哈希，也不放入 `.qbank`。

制作题库通过准确路径复用拓展，不需要修改逻辑分组表。用户要求调整分组时优先使用应用的分组管理；获准直接维护表时保留现有分组 UUID 和无关成员，只修改目标关系，不通过搬动或复制代码实现分组。

新题库绑定 `{id,path}`，path 为数据根目录相对路径；旧 `{id,version}` 和 development 叶名绑定兼容读取。拓展逻辑分组不影响路径，见[宿主导入导出约定](../../../core/docs/reference/LIBRARY_PACKAGES.md)。

## 基础题型与已有样例

源码和已有样例统一在产品的 [单选题](../../../extensions/single-choice-richtext) 与 [简答题](../../../extensions/short-answer-richtext) 基础拓展中。先读 manifest/schema/rules 及声明的 examples，不再维护技能内 scaffold 或最小混合题库。基础题型按精确ID/version复用；仅在用户授权范围内修改，更新前备份并保持答案结构兼容。

复用现有叶不新建样例；确需新题型且已获许可时复制合适叶到授权目录，赋予独立身份，维护复制过来的 examples 并改为新叶精确自绑定。不得让新叶跨目录引用参考样例或修改原基础叶。

## 从 UI 到真实功能

完成 SKILL.md 的设计许可和 UI 访谈概要确认后才制作原型，在同一获准叶目录迭代。管理入口开关只影响入口，Agent 不改设置。

新叶写 `development.json:{}`，从普通 manifest、`QF.page.register`、公开 `project`、`getScore` 返回的真实 `maxScore` 及少量代表题开始。manifest 计划 ID／版本和文件声明见 [API](extension-api.md#清单与公共服务声明)。未完成规则／Schema可做显示预览，但真实提交、评分、保存、编辑必须显式报 `DEVELOPMENT_NOT_IMPLEMENTED`，不能伪造成功；本地演示按 UI 文档标注。UI 获准后补齐同叶规则、Schema、编辑器及公共接口，处理 flush/dispose 和失败。

显示骨架用 `--allow-development --preview-only`，仅预览结构；完整检查只加 `--allow-development`，缺业务实现仍失败。校验、实际功能验收与整库生成的确认条件只按 SKILL.md。旧标记中 entry/script/style/examples/editor/assets 仅只读补缺兼容，manifest 优先，不为新叶创建旧协议。

## 每叶一本样例

`manifest.examples` 指向普通题库格式的 UTF-8 JSON，ID 为 `examples`；可含多道同题型变体，必须自引用本叶 Manifest ID。样例可保留自引用 ID/version，宿主运行时绑定所属目录；不能引用其他叶或建组级混合样例。普通题库使用 `{id,path}`。图片在相邻 assets，用内容哈希引用，格式见 [题库](bank-format.md)。

新样例一律省略 features 或四项 true，免问；已有显式 false 可读，validator 仅警告 `EXAMPLE_FEATURES_SHOULD_BE_ENABLED`。样例和普通题库共用切题、编辑、大纲、白板及历史流程，状态独立。编辑开启时宿主可受控修改样例数据及专属图片，不修改版本代码；功能开关的持久化语义只见题库文档。

## 统一状态（2026-10-13 起）

题库与拓展没有开发版和正式版区分，不需要发布、复制版本或 development.json。可在用户授权范围内原位修改，先备份并保持答案结构和稳定 ID 兼容。新题库 UUID/作者版本与拓展 `{id,path}` 引用遵循宿主导入导出约定；旧绑定兼容。格式 2 拓展平铺，无物理分组迁移。

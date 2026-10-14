# 基础题型库

四种题型当前版本均为 2.0.0，直接平铺在 `extensions/` 根目录，题干和答案与解析使用富文本。“基础题型”分类由 `.state/extension-groups.json` 保存为逻辑分组，没有同名物理分组目录。普通题库按 `{id,path}` 引用实际拓展，`path` 相对产品数据根目录，使用 `/`。版本用于说明拓展版本，不是永久引用键。

| 题型 | ID | 目录 | 评分 |
| --- | --- | --- | --- |
| 单选 | quizforge.single-choice | [single-choice-richtext](single-choice-richtext) | 选对得满分 |
| 简答 | quizforge.short-answer | [short-answer-richtext](short-answer-richtext) | 人工评分或 AI 评分 |
| 多选 | quizforge.multiple-choice | [multiple-choice-richtext](multiple-choice-richtext) | 全部选对得满分，漏选或错选不得分 |
| 判断 | quizforge.true-false | [true-false-richtext](true-false-richtext) | 判断正确得满分 |

简答支持单问或共享材料下的多个小问；提交后默认 0 分，人工评分以 0.5 分为步长自动保存。AI 评分使用应用配置，支持按小问评分；是否提交后自动评分由应用的自动评分设置控制。空白作答计 0 分。

每个拓展含自己的同题型示例。混合展示库位于 [基础题型展示](../question-banks/基础题型/基础题型展示)，共 10 题、总分 38 分。编辑、白板、历史及考试全部开启。

引用示例：

```json
{"extension":{"id":"quizforge.single-choice","path":"extensions/single-choice-richtext"}}
```

已有拓展保留稳定字符串 ID，使用宿主明确支持的兼容模式；新建独立拓展应使用新 UUID。每叶 `examples/bank.json` 保留原自引用，由宿主运行时绑定所属实体。物理目录不随逻辑分组变化；导出的格式 2 包由宿主将关联拓展平铺在 `extensions/` 中，并改写包内题库引用。

产品不再区分开发版和正式版。后续修改先备份，保持答案结构及题目、小题 ID 兼容。导入导出与迁移约定见 [LIBRARY_PACKAGES.md](../core/docs/reference/LIBRARY_PACKAGES.md)。公开仓库和预览包只附带上述四种基础拓展，其他题型可另外制作或随题库包导入。

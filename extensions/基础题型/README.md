# 基础题型库

四种题型均为正式 2.0.0，题干和答案与解析使用富文本。可直接按精确 ID 和版本引用，无需开启开发者模式。

| 题型 | ID | 目录 | 评分 |
| --- | --- | --- | --- |
| 单选 | quizforge.single-choice | [single-choice-richtext](single-choice-richtext) | 选对得满分 |
| 简答 | quizforge.short-answer | [short-answer-richtext](short-answer-richtext) | 人工评分或 AI 评分 |
| 多选 | quizforge.multiple-choice | [multiple-choice-richtext](multiple-choice-richtext) | 全部选对得满分，漏选或错选不得分 |
| 判断 | quizforge.true-false | [true-false-richtext](true-false-richtext) | 判断正确得满分 |

简答支持单问或共享材料下的多个小问；提交后默认 0 分，人工评分以 0.5 分为步长自动保存。AI 评分使用应用配置，支持按小问评分；是否提交后自动评分由应用的自动评分设置控制。空白作答计 0 分。

每个拓展含自己的同题型示例。混合展示库位于 [基础题型展示](../../question-banks/基础题型/基础题型展示)，共 10 题、总分 38 分。编辑、白板、历史及考试全部开启。

正式代码保持版本不变；后续更新应复制为开发叶并发布新版本。开发阶段备份与验证记录保留在产品 .temp/basic-types-release-20261013。

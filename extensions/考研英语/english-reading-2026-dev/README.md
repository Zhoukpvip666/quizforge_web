# english-reading-2026-dev

阶段C：已确认界面，接入公开QF保存/提交/重做和编辑导出接口。正式发布和完整题库生成仍需验收确认。

规则源为rules-source.js，使用项目已有esbuild打包成manifest声明的rules.js；读取共享富文本文档校验器，未修改core。

客观题后端判分；未提交不公开正确答案，提交后按保存结果显示；getScore提供小题状态。

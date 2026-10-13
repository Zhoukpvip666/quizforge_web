# 拓展制作与修改

一个独立拓展提供一个题型和一本只引用自身的样例题库；组合题的小问由该拓展管理。页面、规则和 HTTP 协议见 [API 文档](API.md)。

## 统一状态与目录

题库与拓展不区分开发版或正式版，不需要发布、复制版本或移除标记后才能使用、导出。拓展可在授权范围内原位修改；ID、版本号、API 声明仍用于绑定和兼容，不代表发布状态。不同内容的同 ID/版本包导入时仍拒绝覆盖。

~~~text
extensions/<可选一层分组>/<题型>/
  manifest.json
  practice.html / practice.js / practice.css
  rules.js
  question.schema.json / answer.schema.json
  examples/bank.json
  editor.json / editor.*                 # 可选
~~~

Manifest 声明 ID、版本、名称及文件路径。路径相对于叶目录，禁止符号链接和越界。每个拓展仅提供一个题型，不支持 manifest.types、packageFormatVersion、绑定 typeId。分组只支持一层，不参与身份或版本。

## 绑定、样例与旧数据

新题库统一使用 {"id":"quizforge.my-type","version":"1.0.0"}，可逐题引用不同拓展。样例 ID 为 examples，绑定自身同一 ID/版本。样例的答案和历史独立于普通题库；四项功能开关默认开启。

旧 {"development":"叶名"} 仍按全局唯一叶名解析到 Manifest；development.json 只作为兼容配置读取，不决定可见性、运行或导出权限。旧 .development/.state 作答首次打开时复制到统一 .state，保留原文件与 .pre-unified.bak；冻结历史不改写。新导出包转为可移植 ID/版本绑定。

设置“显示拓展管理”只控制管理入口显示，不影响题库加载。源码变更会使缓存失效；受影响的当前作答重置前保存备份，旧历史仍使用冻结页面。更新前备份数据，修改答案结构时仍需自行设计兼容。

## 保存、评分与统一收尾

页面调用 QF.save 保存完整答案，onFlush 必须等待尚未发送的输入与图片保存，失败时保留输入并明确报错。即时大纲使用 API 1.3 answer-state，稳定小题 ID 必须与 outline 一致。

完成练习时，宿主提交已保存且已作答的未提交题目，复用 grade(data,answer)；不点击页面按钮，不自行判分。拓展需处理空答、部分作答和小题总分。已提交题目不重复评分，未作答题目零分。主观题可返回 pending；AI 失败可重试或人工评分，不能伪造零分。完成前仍先 flush 所有输入。

## 草稿与资源

练习页面响应可用宽度；新草稿固定760逻辑像素，题卡与笔迹共用坐标，手机只缩放或平移。已有草稿 layout 保持原值；设备视图变化不写入共享草稿。拓展不应按物理设备强制改变草稿布局。

静态资源使用 manifest.assets；动态答案图片使用 QF.resources；富文本使用 [公共服务](RICHTEXT_SERVICE.md)。

## 验证与交付

按 [题库制作技能](../../../skills/quizforge-bank-builder/SKILL.md) 验证结构、资源、作答恢复、提交、评分、编辑、历史、草稿与手机。结构校验或原型展示不等于功能验收。未实现接口明确失败。只允许按题库分组导出 .qbank，自动收集全部关联拓展到同名分组；导入校验格式、路径、内容和身份冲突。

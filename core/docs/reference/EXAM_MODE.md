# 考试模式

限时考试使用服务端时间差校准倒计时。到截止时，客户端立即锁定题卡输入和白板，并查询自动交卷状态；网络暂时中断时保持锁定并重试。服务端仍独立检查截止时间，拒绝截止后的答案和草稿写入。单纯计时到点不会提前开放答案、历史或分值汇总，仍需等待服务端交卷状态。

## 配置与生命周期

题库根 `features.exam` 默认 true，仅显式 false 关闭入口。普通练习保留，考试由宿主提供。开始时选择 1–1440 分钟或不限时；限时到点自动交卷，关闭页面不暂停计时。

考试是独立集合 `kind:"exam"`。开始时冻结题目、题序、大纲及拓展文件，与原练习的答案、笔迹、分数分开。开启历史时保存于 `.state/exams/<id>/` 及独立状态文件，服务重启后恢复已保存答案与截止时间。

交卷前 flush 当前页面，随后锁定整卷答案，逐题提交已保存的非 null 答案；未作答计 0 分。截止后输入不能补存。评分失败保留答案，可重试或人工评分；全部处理完成才形成考试历史。这是个人考试练习，不提供反作弊隔离。

已完成考试在原题库的历史列表统一查看与删除，带 `mode:"exam"`；考试入口仅显示未完成及待处理评分。删除未完成考试保存删除标记并使集合失效，在途 AI 结果不再采用；持久快照文件保留，重启不恢复已删除考试。

## 拓展适配

规则复用 `project/validateAnswer/grade/getScore/review/prepareAiGrading`。页面收到 `mode:"exam"`、`exam:{id,status,deadline}`，按能力控制操作：

| 阶段 | 允许 | 禁止 |
| --- | --- | --- |
| 作答中 | draft、whiteboard、即时作答状态 | 单题 submit/retry、编辑、人工或 AI 评分 |
| 交卷后评分中 | 重试固定答案评分、review、AI | 修改答案、笔迹或上传新图片 |
| 已完成/历史 | 只读浏览与定位 | 全部写入 |

考试中 `canSave:true/canSubmit:false`，保存与提交必须独立。`onFlush` 排空保存队列与上传；提交/重做按钮标记 `data-qf-action="submit"/"retry"` 供宿主隐藏，也应按 context 能力控制。宿主同时在服务端拒绝非法操作。内置单选 1.0.0、简答 1.3.0 的已知按钮有兼容处理。

API 1.3 拓展通过 `reportAnswerState` 即时上报未提交的大题/小题进度，关联保存后可恢复；旧拓展保留 getScore 进度查询路径。宿主不从父题有答案推断全部小题已答，交卷前不显示对错。交卷后小题状态由拓展评分输出，待评分的 score 仍为 null。详见[大纲接口](SUBQUESTION_OUTLINE.md)。

自动 AI 沿用 `automatic:true` 计划，可按整题或小题评分；失败保留待处理状态，支持重试及既有 review。任务与 review 参数见[API 文档](API.md)。

## 关闭历史的临时考试

`features.history:false` 时个人作答、图片、任务和结果只留页面会话内存，要求 `X-QuizForge-Practice-Session` 为该页面 UUID；缺少时返回 `409 PRACTICE_SESSION_REQUIRED`，其他页面不能访问。

最多 32 次临时考试，编码大小预算 256 MiB，单次写入预留 32 MiB；容量不足拒绝写入并保留旧答案。30 分钟无访问后释放。规则需要的拓展包暂存磁盘，删除、过期、启动失败或服务关闭时回收。编码预算不是 V8 堆内存上限。

## HTTP 路由

表中 `B=/api/collections/{bank|development-bank}/{id}`，`E=/api/collections/exam/{examId}`。

| 方法与路径 | 行为 |
| --- | --- |
| GET `B/exams` | 列出全部考试；入口过滤已完成项 |
| POST `B/exams` | `{requestId,durationMinutes:60}` 或 `durationMinutes:null`，幂等创建 |
| GET `E` | 考试大纲与状态，附考试元数据和服务器时间 |
| GET/POST `E/exam` | 查询/幂等交卷；已锁定考试只能重试评分 |
| DELETE `E/exam` | 删除未完成或待处理考试，幂等返回 `{deleted:examId}` |
| GET `B/history` | 普通练习及已完成考试；考试记录 ID 为 `exam-{examId}` |
| GET/DELETE `B/history/{recordId}` | 读取/删除冻结历史，只属于原题库 |
| GET `E/questions/{qid}/page` | 本次冻结页面 |
| GET `E/resources/{sha256}`、POST `E/resources` | 读取图片/上传作答图片，交卷后禁止上传 |

删除已完成考试返回 `409 EXAM_COMPLETED`，应使用历史删除接口；已删除考试的读取、交卷与保存返回 404，重放其创建请求返回 `409 EXAM_DELETED`。所有写入仍检查鉴权、来源及页面归属。每次请求与后台定时检查截止时间，不能靠刷新延长考试。

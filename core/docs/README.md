# 开发者文档

运行环境为 Node.js 24，Extension API 为 1.3，题库格式为 1。路径示例相对于产品根目录。

| 文档 | 内容 |
| --- | --- |
| [产品功能清单](../../FEATURES.md) | 用户可见功能、操作入口及功能测试预期 |
| [API 文档](reference/API.md) | 页面 SDK、规则、HTTP 与保存约定 |
| [开发与架构](guides/CORE_SOURCE.md) | 启动、测试、模块职责及数据流 |
| [拓展开发](reference/EXTENSIONS.md) | 文件组织、分组、绑定、样例与兼容 |
| [题库格式](reference/QUESTION_BANK_FORMAT.md) | bank.json、功能开关、资源及 .qbank |
| [大纲与作答状态](reference/SUBQUESTION_OUTLINE.md) | 稳定 ID、定位、即时反馈及评分状态 |
| [富文本服务](reference/RICHTEXT_SERVICE.md) | 文档约定、编辑器、图片与拍照 |
| [考试模式](reference/EXAM_MODE.md) | 计时、交卷、权限与历史 |
| [兼容与迁移](reference/COMPATIBILITY.md) | 版本声明、冻结历史及显式数据升级 |

完整页面、规则、AI 和 HTTP 接口见 [API 文档](reference/API.md)；后端路由与存储细节见 [宿主说明](../server/README.md)；源码目录见 [core/README.md](../README.md)。

# 日常使用流程

[English](USAGE.md) · [简体中文](USAGE.zh-CN.md)

这是产品使用指南，不声明存在独立的 `usage` 工具或可移植工作流包 API。具体能力以当前安装版本的真实目录为准。

## 从对话开始

配置模型后，说明希望得到的结果、工作文件和约束。已有工作选择项目文件夹，其他情况使用托管工作区。选择目录说明工作位置，不授权所有操作；按需确认访问或选择权限模式。参阅[模型](MODEL_CONNECTIONS.md)、[工作区](TASK_WORKSPACES.md)、[权限](PERMISSIONS.zh-CN.md)。

通过附件或引用提供上下文，工具活动展示执行过程；需要核查参数、失败或归档内容时再展开。链接和预览打开真实产物，截图或工具成功返回本身不证明交付正确，应要求适合结果的验证。参阅[文件引用](FILE_REFERENCES.md)、[工具交互](TOOL_INTERACTION.md)、[执行历史](execution-history.md)。

运行中可以排队下一项工作，或给当前任务追加引导。队列稍后开始，引导在安全 loop 边界应用，两者不同。停止必须明确；关闭视图或断开观察不一定停止底层执行，结果未知时先检查原任务再重新提交。

## 建立持续使用的空间

创作是组合 HTML、Markdown、Office、PDF 和媒体的画板。加入文件或让 Agent 排版，内容更新时保留位置、大小和分组；固定版本作对照，选区域继续讨论。渲染由文件适配器决定，导入 HTML 不获得任意宿主访问。

工作中可保存在默认托管空间，完成后将画板及资源导出到指定文件夹，不要求先创建仓库。Team 成员可更新负责区域而保留布局。参阅[画板](creation-canvas.md)、[持续桌面](CREATION_DESK.md)、[预览适配](FILE_PREVIEW_ADAPTERS.md)、[文档插件](DOCUMENT_PLUGINS.md)。

## 复用 Skill、插件与 Team

插件提供可执行能力/连接，Skill 提供说明/资源。安装、启用、完成必要登录并检查实际连接；安装成功、连接成功和业务操作成功分别验证，发现不授予权限。包允许时可手动 `/plugin:skill` 或 `$plugin:skill`，也可让 Agent 查找能力。`/collect` 生成可编辑的经验整理请求，不静默发布 Skill。

Team 保存命名员工和依赖流程。边界清楚的工作用子 Agent，可复用依赖图用 Team，当前任务进度用现有计划工具。计划状态是声明，不等于独立验收。远程员工绑定已验证 worker，模型、文件、权限仍归执行端，跟进原 task/child，不按相同名字寻找另一个 Agent。参阅[Team](TEAM_NATIVE_WORKFLOWS.md)、[插件兼容](PLUGIN_COMPATIBILITY.md)、[远程协议](SUBAGENT_REMOTE_PROTOCOL.zh-CN.md)。

## 浏览器与语音

启用 Browser Use 后确认首次本机扩展连接；页面授权和会话标签组仍独立，个人标签需明确授权/复制。App 与本地 CLI 共用连接器，新标签默认后台避免抢焦点。远程 worker 独立配置浏览器。重试多次失败后等待手动发起，不无限请求。参阅[浏览器接入](CORE_BROWSER_COMPUTER_USE.md)。

常驻麦克风用于转写到草稿，不自动发送；长按主操作按钮进入通话，Stop 结束。转写与通话有独立配置路径，挂断也不代表取消已委派任务。参阅[实时语音](REALTIME_VOICE.md)、[本地语音模型](LOCAL_VOICE_MODELS.md)、[个人助手](PERSONAL_ASSISTANT.md)。

## 自动化、记忆与 CLI

定时任务需写完整需求、模型/工作区和权限预期。时间任务使用保存配置及独立会话，调度宿主必须运行。显式检查未读结果，包括失败；打开不自动标已读。参阅[自动化](AUTOMATIONS.md)、[收件箱](AUTOMATION_INBOX.zh-CN.md)。

上下文在压力时自动压缩，原始历史仍可查。它与可选习惯/预测不同；新会话个性化默认关闭，明确开启后才使用。普通完成只做本地维护，不额外请求模型总结。参阅[上下文与记忆](CONTEXT_AND_MEMORY.zh-CN.md)。

[CLI](CLI.zh-CN.md) 复用 Runtime，提供终端历史、`/tools`、`/artifact`、`/source`、`/session`、排队和引导。聊天运行在 CLI 所在主机，远程执行注册为 worker。npm、Store、源码版本可能不同，排查前先核对实际命令路径及构建。

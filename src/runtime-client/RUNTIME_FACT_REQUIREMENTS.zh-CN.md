# 产品层所需的 Runtime 事实

[English](RUNTIME_FACT_REQUIREMENTS.md) · [简体中文](RUNTIME_FACT_REQUIREMENTS.zh-CN.md)

这是产品需求，不是协议 schema。Runtime 在 bush-protocol 定义/验证值，CardBush 消费解码类型。

## 稳定信封与流式 Turn

可回放事件必须包含协议/版本、事件 ID/单调序号、request/session/Turn ID、创建时间、可区分 kind 和结构化 payload。产品按身份追加/替换，不能以渲染文本去重。

fixture 需按顺序表达接收/开始、思考开始/追加/完成、回复开始/追加/完成，以及明确状态/原因的终态。片段与消息 ID 稳定。收到一段回复或传输关闭不等于完成；终态明确 completed/failed/stopped 或等待用户。

## 工具与权限

需要工具 queued/running/returned/failed/cancelled、调用 ID、显示元数据及与回复片段的顺序关联；权限 requested/answered/rejected/expired/cancelled；通过原调用身份读取精确回执、Runtime 工作区变更和调用错误。可读摘要仅用于显示，不能替代结构化事实。

可操作的 permission_requested 必须给出可授予的 capability ID 或包含它的结构化选择。允许答案只能是请求的子集；产品不能从动作/资源描述、工具名或模型正文猜 ID。permission_answered 保留 allow_once 与 allow_session 的区别，以便回放相同范围。缺少事实时可拒绝/取消，不伪造允许请求。

## 恢复与协作

UI 需观察提供方重试次数/原因/等待时间、连接中断/续读游标、回放重置/被替换分支、用户停止及重试耗尽后的真实终态失败。产品不调度模型重试，不重提原任务；恢复事件可清理临时 UI 状态而无需额外显示一条恢复消息。

Plan、Goal、Subagent、Team 独立保存 ID、修订和生命周期。Plan 进度、Turn 终态都不等于 Goal 完成；子报告的接收/结果状态由 Runtime 记录，不能只凭回复文本判定。历史和实时更新使用相同解码结构。

## 能力与生产边界

启用功能前读取宿主声明的协议和事件/命令能力。缺失时隐藏/禁用，不试探已删除端点猜支持。

本机生产执行以 TypeScript Runtime Host 为权威，经类型化 Electron IPC 消费共享事实，不依赖本地 HTTP/SSE 路由、snake_case 兼容投影或 HTTP 状态约定。独立远程 worker 的传输适配另有明确边界，不改变本地 Runtime 的事实所有权。

# subagent-remote-proton 0.1

[English specification](../../../SUBAGENT_REMOTE_PROTOCOL.md) · [中文规范](../../../SUBAGENT_REMOTE_PROTOCOL.zh-CN.md)

Experimental interaction contract. [Control](control.schema.json), [observation](observation.schema.json), [interaction](interaction.schema.json), and [capabilities](capabilities.schema.json) schemas are generated from `packages/bush-protocol/src/remoteInteraction.ts` by `node scripts/export-worker-protocol.mjs` after building the protocol package.

The current CardBush HTTP adapter uses `delegation.submit` and `delegation.control`. The design follows MCP's client/service connection pattern while retaining the existing subagent lifecycle. This adapter does not yet implement MCP wire compatibility; another host maps the interaction contract to its own loop without adopting CardBush tool names. Scoped parent credentials and independent-implementation validation remain release gates. Existing service owner tokens are administrative credentials.

Authentication and authority are transport/host facts, never message-body claims. Text cannot authorize a permission. A parent can stop observation without cancelling work; cancellation requires a separate control receipt and confirmed task state. IDs and state are generic; implementing peers do not need any CardBush model-facing tool names.

当前为实验性交互契约。控制、观察和交互的 JSON Schema 由协议源代码生成。当前 CardBush HTTP 适配器使用 `delegation.submit` 和 `delegation.control`，设计学习 MCP 的客户端/服务接入方式，生命周期复用已有子 Agent。此适配器尚未实现 MCP 线上兼容；其他宿主将交互契约映射到自己的 loop，无需采用 CardBush 工具名。按父 Agent 隔离的凭据和独立实现验证仍是发布门槛；现有服务 owner token 属于管理凭据。

认证和授权依据来自传输层与宿主，不能由消息正文自行声明。自然语言不能替代授权。结束观察不等于停止工作；取消必须有独立回执及已确认的任务状态。实现方不需要使用任何 CardBush 模型工具名称。

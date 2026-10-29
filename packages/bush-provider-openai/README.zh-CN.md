# 模型失败与 Responses 兼容

[English](README.md) · [简体中文](README.zh-CN.md)

Responses、Chat Completions 和 Anthropic Messages 经 `providerErrorPayload/providerFailureEvent` 统一 HTTP 与流中错误，保留原错误码（或类型）、状态和 request ID。Runtime 的 `modelFailurePolicy` 负责共同重试分类；适配器只解码协议事实，不执行工具。见 [Runtime 模型失败边界](../bush-runtime/README.zh-CN.md#模型失败边界)。

Responses 通过 `ProviderCapabilityStore` 共享兼容配置，范围绑定端点配置、凭据和模型。只有明确拒绝实际已发送功能，才选择兼容投影；鉴权、额度、暂时服务故障和无关输入校验不改变能力。

兼容投影使用普通 `mcp_search/get_tool_schema/call_tool` 函数，`store:false` 发送完整历史，本地估算输入，在完整函数结果批次后追加有来源的工具图像观察。渐进发现、指令、推理和结果继续可用，仍是 Responses，不切换 API 家族或模型设置。

尚未暴露任何文本、推理、工具调用或用量前，显式功能拒绝（含早期 SSE）可用兼容投影重试。已有输出后返回失败，确认的能力观察只影响后续请求。取消、本地校验及大小失败不选择兼容配置。

缺失/过期 `previous_response_id` 走独立恢复：丢弃旧锚点，发送包含已完成工具结果的完整本地历史，不改能力、schema、缓存路由或存储。恢复结果可成为新锚点。鉴权、无关资源缺失、已暴露输出的失败不能进入此路径。

这两类恢复共用 Runtime `ModelRequestAttempts` 的单次 wire recovery 配额，并与同轮普通传输重试共享。恢复后再遇 503 继续使用恢复后的投影，即使能力观察到期也不重置额度、不恢复旧 ID。Anthropic 明确拒绝 `cache_control` 时也使用该额度移除可选字段。SDK 自动重试禁用。

精确计数失败保留原错误并不返回测量值，Runtime 可本地估算。404/405/501 只标记计数路由不支持，不改变生成能力；计数不消耗生成尝试。

`provider_compatibility` 日志保留原码、信息、HTTP 状态、request ID，以及恢复是否重试/成功/失败/推迟。生成事件与 `provider_retry` 使用同一 `providerAttempts/recoveryAttempts`；诊断脱敏配置凭据，控制台也带请求/会话标识。

能力配置默认 7 天到期；期间新会话和重启直接复用，不重复失败探测，复用不延长有效期。到期后的新会话重新评估；成功兼容响应在已验证回放中记下模式，使现有会话到期或重启后仍保持兼容。旧原生调用仅在发送投影中翻译，不改持久历史。首次切换可能使缓存前缀失效一次，其后保持稳定。不同模型/端点独立；改端点配置或凭据选用另一配置。

先 `npm run build:runtime`，再运行 `node --test packages/bush-provider-openai/test/*.test.mjs`。`providerLoop.test.mjs` 覆盖三类协议的 HTTP/流失败及已完成工具保留；`responsesContinuation.test.mjs`、`providerCompatibility.test.mjs`、`protocolParity.test.mjs` 覆盖有限恢复、取消、连续故障、到期和历史保留。

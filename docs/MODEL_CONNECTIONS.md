# 模型接入与请求头

在 **应用中心 → 设置 → 模型管理** 点击「添加模型」或已有模型的编辑按钮。列表只展示名称、接入协议、地址和凭证状态；编辑使用独立弹窗。模型商用于分组，接入协议独立选择，不按模型名称猜测，也不在请求失败时切换协议。

| 接入协议 | API 根地址示例 | 请求路径 | 默认鉴权 |
| --- | --- | --- | --- |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` | `Authorization: Bearer …` |
| OpenAI Chat Completions | `https://api.openai.com/v1` | `/chat/completions` | `Authorization: Bearer …` |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` | `x-api-key`、`anthropic-version: 2023-06-01` |

第三方网关请填它提供的 API 根地址，包含所需的 `/v1` 或其他路径前缀，不要再追加 `/responses`、`/chat/completions` 或 `/messages`。未指定协议的已有配置保持 Responses。编辑已有模型时 API Key 留空保留已保存的密钥；获取模型列表需要在当前弹窗输入密钥，列表请求同样采用所选协议的鉴权和自定义请求头。

## OpenCode Go

例如选择 Responses，地址填 `https://opencode.ai/zen/go/v1`，模型填服务支持的真实模型 ID。对 `opencode.ai` 的模型请求自动发送：

- `User-Agent: CardBush/1.0`（高级选项可自定义）。
- `x-opencode-session` 使用 Runtime 当前对话 ID。同一对话的追问、工具后续请求、维护请求和重试复用该 ID；不同对话独立。手动填写的同名固定头不会覆盖真实对话 ID。

请求头在每次 SDK 调用的请求选项中生成，共享客户端不保存可变的当前会话 ID，也不会将头部塞进模型输入。计数请求使用同一规则。模型列表是独立的元数据查询，使用 `cardbush-model-discovery` 标识。要求来自 [OpenCode Go 文档](https://opencode.ai/docs/go/)。

## 高级选项

可设置上下文上限、最大输出 tokens 和 JSON 格式的自定义请求头。例如：

```json
{
  "x-project": "example",
  "x-session-id": "{{sessionId}}"
}
```

`{{sessionId}}` 在发送时替换。头名称不区分大小写，不允许重复名称、换行或覆盖 `Host` / `Content-Length` 等传输字段。留空或 `{}` 可清除自定义头。头中的凭据属于模型连接配置，不写入会话的 Provider binding 引用或输入指纹；开启配置同步时，和模型密钥一起传入已授权的 Agent。

Anthropic Messages 要求 `max_tokens`，未填写输出上限时使用 8192。其高级选项另有思考参数模式：默认「自适应」将所选推理强度发送为 `thinking.type=adaptive` 和 `output_config.effort`；旧模型可选择「Token 预算」，预算至少 1024、严格小于输出上限。未指定推理强度或选择 `none` 时不发送思考覆盖参数，遵循供应商默认，这不保证所有模型都关闭思考。支持的强度仍由具体模型决定，详见 [Anthropic 思考配置](https://platform.claude.com/docs/en/build-with-claude/thinking)。

## 运行时与验证边界

三种协议只有一个 Agent loop。`ModelProviderRegistry` 选择适配器；Runtime 统一构造 `ModelRequest`、消费 `ModelEvent`，由 `executeModelRound` 和 `InMemoryRuntimeHost` 决定工具执行、权限、停止、重试、上下文维护和持久化。协议适配器只转换输入与输出，不持有另一份会话状态，不自行调用工具或追加下一轮。

公共连接配置、图片读取、具名指令、工具名映射和发现回执独立于 Responses 实现。各适配器根据协议编排角色与内容块，将返回统一为正文、思考、工具调用、用量、完成或失败事件。签名思考和 Responses 原生回放保存在不透明附加数据中，Runtime 只携带、不解释；这些传输能力的差异不会生成不同的 Agent 循环。

三种协议复用 Runtime 的执行、权限、取消、上下文维护和用量统计。工具调用、工具结果和图片分别映射到各协议的合法结构。Chat Completions 的工具结果图片在整批工具结果之后发送；Messages 将工具结果合并为 user content blocks，并在原模型和绑定未变且消息完整时保留签名思考块。

连接配置按修订绑定。修改协议、凭据或请求头会生成新修订，已开始的回合保持原绑定。服务器流中断、缺失结束标记或调用身份不完整不会被当成成功；输出截断时不执行未确认的工具批次。传输完整但参数 JSON 或 schema 不合法时，沿用 Runtime 的工具错误回执和后续生成流程；Messages 无法用输入对象表示的历史调用及对应错误回执投影成文本，不能伪造合法参数。Chat Completions / Messages 使用完整历史和本地输入估算，不使用 Responses 的 `previous_response_id` 或精确计数端点；原 Responses 原生工具发现和兼容投影继续保留。

本机和独立 Agent 共用模型配置及 Provider factory。部署到远端时需更新 Agent 运行时及依赖，只同步模型配置不足以给旧版服务增加新适配器。

离线回归包括 SDK 请求头与路径、并发会话、重试、分片 SSE、工具往返、签名思考回放、图片、取消、中断、HTTP 错误、字节预算，以及真正的 Agent Worker 请求和编辑弹窗。使用虚构密钥与本地服务，不代表特定账户、付费额度或网关下所有模型均已实测。

接口依据：[OpenAI Chat Completions 流事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create) 与[流式事件](https://platform.claude.com/docs/en/build-with-claude/streaming)。

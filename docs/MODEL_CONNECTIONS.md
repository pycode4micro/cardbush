# 模型接入与请求头

在 **应用中心 → 设置 → 模型管理** 点击「添加模型」或已有模型的编辑按钮。列表展示名称、接入协议、思考强度、地址和凭证状态；编辑使用独立弹窗。模型商用于分组，接入协议可独立选择；新建空连接支持服务商预设，不按模型名称猜测，也不在请求失败时切换协议。

## 选择接入方式

- **API Key**：使用服务商提供的密钥、API 根地址和模型 ID。下面的三种协议、OpenRouter、OpenCode Go 与自定义请求头说明适用于这条路径。
- **ChatGPT · SIWC**：本机模型编辑器内选择该授权方式，点击 **Continue with ChatGPT**，在系统浏览器完成账号授权，再从账号返回的列表中选择模型。无需填写 API Key；普通插件／MCP 的 OpenAI 登录不能替代这里的推理授权。

SIWC 模型列表来自所选账号，界面展示服务返回的名称，调用使用实际模型标识。不会通过手写固定名单保证某个模型可用；列表可见也不等于推理请求一定有权限。账号中心可重新登录、打开用量设置或退出，遇到额度或授权错误不会自动切换账号或 API Key。

SIWC 复用 Responses 适配器和同一 Agent 循环，但按账号接入约束发送流式、`store: false` 请求。OAuth 凭据保存在本机加密凭据库，不进入模型配置或会话记录，也不随配置同步到远端 Agent；远端需配置自己的受支持凭据。具体协议、参数与验证范围见 [SIWC 接入说明](SIWC_INTEGRATION.md)。

标准和精简输入框收起时都只显示模型名称；点击后再查看服务商、协议和对应的思考设置。

assistant 的模型选择独立于普通会话，输入框显示与实际请求使用同一份选择；未选择时使用当前默认模型。普通继承型子代理在首次派发和续派时跟随父会话本轮使用的模型及参数，续派保留原子会话历史。显式独立配置的 clean 子代理和远端执行主机保留自己的配置，通话模型仍由语音设置控制。

## 每个模型的思考强度

「思考强度」按模型配置 ID 独立保存，模型同名、不同服务商或不同连接也不会共用。模型管理弹窗和输入框快捷选择修改同一配置；切换模型、新建对话和重启后都读取该模型自己的设置。旧的全局强度不再作为回退，也不会复制给所有模型。

未设置的模型使用「服务商默认」，请求省略思考覆盖参数；它与「关闭」不同。输入框可点击「默认」恢复该状态。保存失败保留原设置并显示错误，快捷更新仅修改指定模型，不改默认模型、密钥和其他模型的参数。

本地、云 Agent 和模型配置同步都携带该字段。云端排队请求保存发送时明确选择的强度（包含明确的服务商默认）；未指定强度的 API 客户端读取目标模型配置。切换到其他模型的子 Agent 使用该模型设置，仍允许明确的子任务强度覆盖；沿用父模型的子任务继续继承父任务参数。后台记忆总结和定时任务也使用对应模型的配置。

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

## OpenRouter

添加模型时选择 `openrouter`。新建且地址为空时预填 `https://openrouter.ai/api/v1` 和 Chat Completions；填写 OpenRouter API Key，获取列表后选择完整的 `provider/model-id`。仍可手动选择 Responses 或 Messages。修改已有配置的服务商名称不会覆盖原地址/协议，已填写的自定义地址也不会被预设替换。

仅对实际主机名为 `openrouter.ai` 的请求自动设置：

- `x-session-id`：使用执行请求的真实会话 ID，最多 256 字符。同一会话的续轮和重试保持一致；新对话和独立子会话分别使用自己的 ID。同名的静态自定义头不能将多个会话固定成一个。
- `X-OpenRouter-Title: CardBush`：允许通过同名头或兼容的 `X-Title` 自定义。不自动指定 `HTTP-Referer`，有应用归因需求时可在高级选项配置。
- 三种协议均使用 Bearer 鉴权；Messages 不沿用 Anthropic 官方服务的 `x-api-key` 鉴权。模型列表也使用 Bearer，请求标识为独立的 `cardbush-model-discovery`。

Chat Completions 将产品的 `low / medium / high` 三档写入 OpenRouter 的 `reasoning.effort`，未指定强度时不覆盖服务商默认。输出上限同时约束思考与可见输出。流式 `reasoning`、兼容的 `reasoning_content` 和 `reasoning_details` 均能处理；重复的可见思考只显示一次，加密数据和签名只用于续轮。思考详情按流顺序原样保存，在模型、连接修订和消息未变时随工具结果一起回放；切换模型/绑定或修改消息后不复用旧侧车数据。截断、中断和错误不能确认未完成的工具调用。

会话头只帮助网关维持路由与缓存亲和性，不代表服务端自动保留对话历史。Chat/Messages 仍发送已有完整历史；本地缓存指纹记录实际参数与消息，缓存命中以服务端返回用量为准。依据：[OpenRouter 快速接入](https://openrouter.ai/docs/quickstart)、[会话与提示词缓存](https://openrouter.ai/docs/guides/best-practices/prompt-caching)、[思考与回放](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)、[Messages 鉴权](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message)。

2026-09-29：Provider 全量 257 项（含 OpenRouter 专项 14 项）、独立 Agent 接入 1 项通过；协议包与 Provider 构建、前端及 Electron 类型检查通过。覆盖三协议鉴权、并发父子会话、思考回放隔离、流截断与错误；设置弹窗验证预设、获取列表、已有地址保护与中英文显示。真实公开 `/api/v1/models` 返回 460 个模型。未使用 OpenRouter 账户做付费生成测试，因此不代表所有模型、额度或服务商路由均已在线验证。

## 高级选项

可设置上下文上限、最大输出 tokens 和 JSON 格式的自定义请求头。例如：

```json
{
  "x-project": "example",
  "x-session-id": "{{sessionId}}"
}
```

`{{sessionId}}` 在发送时替换。头名称不区分大小写，不允许重复名称、换行或覆盖 `Host` / `Content-Length` 等传输字段。留空或 `{}` 可清除自定义头。头中的凭据属于模型连接配置，不写入会话的 Provider binding 引用或输入指纹；开启配置同步时，和模型密钥一起传入已授权的 Agent。

Anthropic Messages 要求 `max_tokens`，未填写输出上限时使用 8192。其高级选项另有思考参数模式：默认「自适应」将所选推理强度发送为 `thinking.type=adaptive` 和 `output_config.effort`；旧模型可选择「Token 预算」，预算至少 1024、严格小于输出上限。未指定推理强度时不发送思考覆盖参数，遵循供应商默认；选择「关闭」/ `none` 时明确发送 `thinking.type=disabled`，不把省略参数当作关闭。支持的强度仍由具体模型决定，详见 [Anthropic 思考配置](https://platform.claude.com/docs/en/build-with-claude/thinking)。

当前 Chat Completions 接入提供 `low / medium / high` 三档，输入框和实际请求共用映射。历史配置中的 `xhigh / max` 归到 `high`，`none` 归到最低可用的 `low`；未配置强度时仍不发送覆盖值。编辑协议时先展示对应映射，保存后按该协议支持的档位保存。三档是当前产品接入策略，并不表示所有 Chat Completions 模型都只有这三档。Responses 和 Messages 的可选范围保持各自原有设置。

输入框模型列表在服务商旁显示 `Responses`、`Chat Completions` 或 `Messages`，悬浮显示完整协议名称；旧配置未指定协议时与运行时一致按 Responses 处理。控制区跟随所选连接：Responses / Chat 为「推理强度」，Messages 自适应为「思考强度」，Token 预算模式为「思考预算」。选中档位位于另一页时自动显示该页，三档模式不保留展开按钮占位；欢迎页、主会话及子会话复用相同组件。

Messages 默认发送 `cache_control: { type: "ephemeral" }` 启用自动提示词缓存。仅当端点明确以参数校验错误拒绝 `cache_control` 时，在输出开始前去掉该字段重试一次，并按连接及模型记录不支持；鉴权、输入超限、其他参数错误和流中断不会触发这项降级。缓存命中仍以供应商返回的用量为准，本地 CacheChain 记录不代表已经命中缓存。

## Responses 计数与生成能力

输入计数和生成使用独立的能力记录，按连接配置及模型隔离。`/responses/input_tokens` 返回 404、405 或 501 时，只把 `input_token_count` 标为不可用，改用本地估算；原生工具、工具图片和 `previous_response_id` 请求保持原样。记录默认七天过期，重启沿用，读取不延长有效期。鉴权、限流、临时故障和输入校验失败不保存为「计数接口不支持」，接口恢复后仍可正常计数。

生成只有明确拒绝当前请求实际包含的能力（原生工具发现、续轮、存储或工具结果图片）时，才采用 Responses 内的兼容投影。输出开始前最多重试一次；已展示文字或工具调用时不重放当前请求。401／403、429、临时服务错误和普通参数错误不会改变请求格式。501、505 表示功能或协议不支持，不作为临时服务故障自动重试；其他临时错误仍由 Runtime 使用冻结请求重试。

生成降级使用独立的 `responses_generation_compatibility` 标记，不读取或迁移旧的宽泛降级标记，也不添加旧会话兼容分支。当前会话一旦实际完成兼容投影，后续请求保持该格式，避免在记录过期后改写前缀。生成采用兼容投影也不关闭可用的计数接口，计数与实际生成使用相同的输入投影。

离线回归比较计数失败前后的实际生成请求，验证请求内容、作用域、重启及过期行为，并检查错误诊断和重试次数。它验证本地架构稳定性；真实缓存命中仍需以服务商返回用量为准。

## 运行时与验证边界

三种协议只有一个 Agent loop。`ModelProviderRegistry` 选择适配器；Runtime 统一构造 `ModelRequest`、消费 `ModelEvent`，由 `executeModelRound` 和 `InMemoryRuntimeHost` 决定工具执行、权限、停止、重试、上下文维护和持久化。协议适配器只转换输入与输出，不持有另一份会话状态，不自行调用工具或追加下一轮。

公共连接配置、图片读取、具名指令、工具名映射和发现回执独立于 Responses 实现。各适配器根据协议编排角色与内容块，将返回统一为正文、思考、工具调用、用量、完成或失败事件。签名思考和 Responses 原生回放保存在不透明附加数据中，Runtime 只携带、不解释；这些传输能力的差异不会生成不同的 Agent 循环。

三种协议复用 Runtime 的执行、权限、取消、上下文维护和用量统计。工具调用、工具结果和图片分别映射到各协议的合法结构。Chat Completions 的工具结果图片在整批工具结果之后发送；Messages 将工具结果合并为 user content blocks，并在原模型和绑定未变且消息完整时保留签名思考块。

Messages 只将对话开始前的固定 system/developer 指令放进顶层 system。对话中的 Runtime 指令保留原顺序，在 user content 中明确标注来源，供没有中途 developer 角色的 Messages 接口继续处理；Canonical 历史中的角色不变。Provider 缓存指纹按内容块记录，向同一个 user 内容数组追加维护通知不会误报整个前缀被改写。

Messages 的明确输入超限错误，以及流中 `model_context_window_exceeded` 停止，都会转为共享的上下文恢复信号。Runtime 在具备维护条件时进行有次数上限的压缩并继续任务；条件不足或恢复失败时明确失败，不把截断正文显示成成功。被放弃的流式正文在恢复时从界面清除，未确认的工具调用不会执行。

连接配置按修订绑定。修改协议、凭据或请求头会生成新修订，已开始的回合保持原绑定。服务器流中断、缺失结束标记或调用身份不完整不会被当成成功；输出截断时不执行未确认的工具批次。传输完整但参数 JSON 或 schema 不合法时，沿用 Runtime 的工具错误回执和后续生成流程；Messages 无法用输入对象表示的历史调用及对应错误回执投影成文本，不能伪造合法参数。Chat Completions / Messages 使用完整历史和本地输入估算，不使用 Responses 的 `previous_response_id` 或精确计数端点；原 Responses 原生工具发现和兼容投影继续保留。

本机和独立 Agent 共用模型配置及 Provider factory。部署到远端时需更新 Agent 运行时及依赖，只同步模型配置不足以给旧版服务增加新适配器。

离线回归包括 SDK 请求头与路径、并发会话、重试、分片 SSE、工具往返、签名思考回放、图片、取消、中断、HTTP 错误、字节预算，以及真正的 Agent Worker 请求和编辑弹窗。使用虚构密钥与本地服务，不代表特定账户、付费额度或网关下所有模型均已实测。

2026-09-29 对齐修复验证：锁文件依赖下构建和前端类型检查通过，Provider、Protocol 与相关 Runtime 回归 362 项及 Agent Worker 接入 1 项通过。其中 `protocolParity.test.mjs` 新增 20 项，覆盖上下文恢复、截断、消息顺序、缓存降级边界和推理档位。`node scripts/run-app-views-test.mjs model-protocols` 验证欢迎页、普通会话、嵌入会话的中英文菜单，以及切换协议后保留原档位偏好。真实服务端缓存命中未在线验证。

接口依据：[OpenAI Chat Completions 流事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create) 与[流式事件](https://platform.claude.com/docs/en/build-with-claude/streaming)。

Messages 的流式诊断通过 `provider_stream_diagnostic` 记录请求配置、块边界、停止原因和用量，并每 30 秒记录进度或等待。只保存元数据，不记录内容或密钥，不改变缓存前缀及重试策略。停止原因在 `message_delta` 时就记录，便于区分输出额度截断和缺少最终 `message_stop`。2026-09-29 使用同一冻结请求做了两次真实 DeepSeek Messages 调用，均完整结束，详见 [复测记录](MESSAGES_STREAM_REPLAY_2026-09-29.md)。

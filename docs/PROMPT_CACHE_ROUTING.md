# 会话缓存路由与图片诊断

## 适用范围

Responses 和 Chat Completions 适配器向已确认支持的 HTTPS 接口发送 `prompt_cache_key`：

- OpenAI 公共 API：`api.openai.com`。
- 火山方舟原生 API：`ark.<region>.volces.com`，包含当前使用的北京区域。

标识由会话 ID 的带命名空间 SHA-256 摘要生成，不包含原始会话 ID、API Key、请求 ID 或时间。同一会话的追问、工具续轮、重试、上下文整理和应用重启复用同一标识；不同会话互相隔离。它是路由提示，不是新的上下文或缓存副本。

未知兼容网关、OpenCode、OpenRouter 和 ChatGPT 登录通道不自动添加该参数。Anthropic Messages 继续沿用自己的缓存协议。单纯兼容 OpenAI 的接口不意味着支持所有可选参数。若以后要扩展支持范围，需核实供应商的接口契约并增加相应请求测试。

本次不启用方舟显式缓存，不改变 `store`、响应续接、图片处理、历史消息和共享 loop 的策略。输入计数接口不接收路由字段；token 预算和校准不将其计入输入。路由状态单独记录，不伪装成提示词前缀变化。

## 诊断数据

`provider_input_observed` 记录实际发送前的投影，而非预估或未发送的草稿：

| 字段 | 含义 |
| --- | --- |
| `cacheRouting.mode` | `session` 表示发送了会话缓存路由标识，`provider_default` 表示未添加 |
| `cacheRouting.keyDigest` | 路由标识摘要，用于核对同会话稳定性；不记录原值 |
| `images.count` | 完整逻辑输入的图片数量，响应续接时仍包含历史图片 |
| `images.remoteCount` | 以 HTTP(S) URL 引用的图片数；URL 不变不能证明远端像素未变 |
| `images.comparisonAvailable` | 是否有相同协议的上一份图片诊断可供比较 |
| `images.addedCount` / `removedCount` | 按图片块摘要及出现次数计算的增减；重复追加同图也会计为新增 |
| `frozenPrefixBreak` / `changedParameters` | 原有历史输入及参数变化检测，继续保留 |

图片诊断读取三种协议的实际图片块，覆盖用户图片和工具图片；不解析正文中看起来像图片的 JSON。用于比较的摘要保存在投影状态中，不额外存放原始像素、图片 URL 或提示词。图片摘要包含细节选项；修改已有图片与新增图片都应结合前缀变化判断，不能只看新增数量。

老会话没有图片摘要，或切换协议时，第一份诊断只建立基准，`comparisonAvailable=false`；不会把所有历史图片误报为本次新增。

图片增减相对于上一次实际投影，包含失败尝试。若带新图片的请求失败后重试，相同图片在重试投影里的 `addedCount` 为零；分析时需沿请求事件检查首次引入的位置，不能将它误归为未携带图片的请求。

`model_request_usage.providerInputSequence` 指向同一 Turn 中准确的 `provider_input_observed.sequence`。适配器兼容重试时指向最终实际请求；引导打断但供应商已经回报用量时也保留关联。未提供用量或投影的旧适配器不伪造相应数据。

排查时先关联这两个事件，再按“新增图片 / 无新增图片”、前缀是否变化和路由标识分组。命中率仍为供应商回报的 `cachedInputTokens / inputTokens`，不能用本地摘要推算命中事实，也不能把图片相关性直接当作供应商缓存内部失效的证据。

## 验证与效果边界

回归覆盖真实 SDK 请求体、并发会话、重试和重启稳定性、三个协议的图片投影、旧状态恢复、工具续轮和引导打断后的用量关联。测试使用本地固定数据和模拟响应，没有向供应商重发用户历史对话。

缓存路由提示有助于服务端把同会话请求路由到可复用缓存的实例，但不保证命中。下一次真实使用才能衡量改动后的收益；尤其需要比较新增图片请求的命中率，不能承诺恢复到某个固定百分比。

供应商契约：[方舟 Responses API](https://docs.volcengine.com/docs/ark/create-model-responses-api?lang=zh)、[方舟 Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh)。OpenAI 请求字段同时由仓库使用的 SDK `ResponseCreateParamsStreaming` / `ChatCompletionCreateParamsStreaming` 类型约束。

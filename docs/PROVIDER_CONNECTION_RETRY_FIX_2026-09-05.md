# 模型连接中断与持续重试修复

## 现场结论

会话：`local-920fa679-9e8b-43ac-afa1-e88903074107`

Turn：`turn_d5c4c700-6961-4d53-b5ba-8f3c0266b494`

- 2026-09-05 14:03:19 至 14:06:13（UTC+8），先完成了 13 轮模型请求和 20 次工具执行。
- 下一轮连接失败。桌面 Host 配置最多 5 次尝试，但 Runtime 默认延迟为 0，约 0.1 秒就耗尽了这些尝试。
- 保存的事件只有 `code: "Error"` / `message: "Connection error."`。SDK 的 `APIConnectionError` 把底层异常放在 `cause` 中，旧映射没有保留它。
- 没有发生上下文压缩；18 次 cache-chain 观察均没有 frozen-prefix break。最后一次成功请求约 44k 输入，不是窗口超限。
- 工具输出里另有用户项目测试脚本对 `null.length` 的访问错误；这是模型已收到的工具执行结果，不是这次模型连接失败。此次没有改用户项目。

## 隔离真实 API 验证

使用 `scripts/probe-provider-session.mjs` 验证原始消息：

```powershell
node scripts/probe-provider-session.mjs local-920fa679-9e8b-43ac-afa1-e88903074107
# 确认会发送真实请求时才加此参数：
node scripts/probe-provider-session.mjs local-920fa679-9e8b-43ac-afa1-e88903074107 --send
```

该脚本目前仅支持一个原始 committed Turn；检查 journal checksum 和全部消息指纹，不匹配就拒绝请求。
读取当前已配置模型，但不输出凭据。临时 Host 仅构建工具清单，绝不运行 loop 或执行返回的工具。

2026-09-05 14:21 的结果：

- 37 条消息逐条指纹一致。
- HTTP 200；响应头约 253ms，总耗时约 4.25 秒。
- 正常返回 `finishReason: tool_calls`，提出 `terminal_poll` 和 `read_file`，均未执行。
- input 43,252 / output 331 tokens；原始 session journal 未变。
- 工具清单采用当前 20 个内置工具重建；原始动态 MCP 工具定义未持久化，因此不是完整请求报文的逐字重放。

这更支持“当时连接临时异常”的判断。旧日志缺失底层 cause，不能进一步断言是服务商、代理、DNS 还是本地网络，也不能排除未逐字重放部分的差异。

## 行为变化

- 桌面 Host 默认 `maxAttempts: null`：可重试连接错误持续重试，直到成功、用户 Stop 或明确不可重试错误。
- 延迟依次为 1、2、4、8、16、30 秒，之后保持 30 秒；服务端有效的 Retry-After 可延长等待，安全上限 5 分钟。
- 保留显式正整数环境变量 `CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS` 作为有限次数覆盖。库级默认仍为 1，不改变其他独立调用方的重试次数策略。
- SDK `maxRetries: 0`，重试只有 Runtime 一个所有者。SDK 连接/超时异常、已知 socket/DNS 中断、HTTP 408/409/429/5xx 可重试。
- 400/401/403、明确耗尽额度、已知 URL/请求配置/证书错误、本地图片输入错误与本地编程错误不盲目重试。HTTP 状态优先于错误字符串。
- Responses 明确终止失败的语义不变；不根据模型文字、错误消息文本或兼容性猜测偷偷续跑。结构性事件身份/顺序错误也不进入无限重试。
- 重发同一轮的 request/messages/tools/providerState，不从原始用户请求重开 Turn，不重复已完成工具。失败尝试仅撤下本次未完成输出，不撤下此前工具事实。
- 保留有界的错误类名、cause code、HTTP 状态、provider request id。不会新增原始 cause 消息、stack、headers、URL 或请求内容到诊断字段。
- UI 同时显示原因、实时倒计时和 Stop 提示；收到真实模型输出/工具调度后清除重试提示。cache 观察、replay reset 本身不会被当作连接恢复。

等待不会请求模型；再次发起请求仍可能产生服务商计费。这里保证不主动重放已完成的工具，不保证服务商对已生成但连接中丢失的内容免计费。

本次不改变 token-count 端点、上下文压缩策略、工具执行状态或自动回退模型/接口的策略。
该修复不会自动复活已经归档失败的 Turn；未自动重跑该现场，避免重新执行已有副作用。

## 验证与生效

- 新增：SDK cause / AggregateError / SSE 中断、HTTP 与 Retry-After、持续超过 5 次后恢复、原请求保持不变、工具仅执行一次、Stop 中断五分钟等待、不可重试错误停止。
- 完整 `npm run test:runtime`、48 项前端/架构 contract、TypeScript 检查及 Vite 构建。
- 隔离 Chromium UI：倒计时转请求中、错误原因始终可见、终态去掉持续重试提示；实际事件消费链验证重连后清理提示且不吞正文。
- 修复一处既有 UI 测试定时等待的抖动：等待 CSS 过渡真正结束，不再假定 130ms 一定完成。

源码和本地构建更新后，已启动的 Runtime 进程仍需重启。旧打包产物不会随源码自动更新，需要重新打包。

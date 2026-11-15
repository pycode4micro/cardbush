# Assistant / DeepSeek 工具调用一致性错误取证

状态：**已定位报错层和失败所在的模型轮次；原始失败流未保存，尚未确认本次根因。未修改运行时或校验规则。**

## 确认的事件

用户确认调查对象是 2026-11-15（北京时间）Assistant 中的“你当前都有哪些子agent”，报错后手动重试成功。绑定模型是火山方舟 Coding Plan 的 `deepseek-v4.1-flash`，协议为 Responses API。

| 时间（UTC+8） | 已保存的证据 |
| --- | --- |
| 10:45:14.880 | 用户消息入库。 |
| 10:45:15.163 | 首次请求前的环境快照。 |
| 10:45:19.621 前 | `tasks(action=list)`、`list_subagent_options` 的模型调用和两份工具结果已经写入模型历史。 |
| 10:45:19.621 | 下一次模型请求前的环境更新。随后没有成功模型消息落盘。 |
| 10:46:02.377 | 重试请求前的环境更新；Assistant execution ID 已改变。 |
| 重试后 | 成功调用 `summary_for_user({"expression":"curious"})`，接收其结果并生成最终回复。 |
| 10:46:08.872 | 最终回复入库。 |

据此，错误范围缩小到两项查询已返回之后、下一条成功模型消息之前。无法据现有记录确定失败流实际准备调用哪个工具；不能直接认定失败的是 `summary_for_user`。历史中没有第二次执行前面两项查询的记录。

本机源证据在 `%APPDATA%/cardbush/runtime-state/conversation-journal/b0e8405deea03a25f94989629cbb3f7cb7741745c565e826b759e9accb700866.jsonl` 及同名 `.model.jsonl`。这些是会话数据，不复制进仓库。

## 报错层和证据缺口

- 错误文字来自 [responsesToolCalls.ts](packages/bush-provider-openai/src/responsesToolCalls.ts) 的 `ResponseToolCalls.#changed()`，错误码为 `provider_tool_call_changed`。它是本地 Responses 适配器的校验错误，不是能直接证明供应商改了参数的原始服务端错误。
- 触发条件共用这条错误：调用 ID、名称、类型或索引冲突；参数增量与完整参数不一致；参数完成后又出现非空增量；重复调用 ID 等。错误文字本身不足以区分这些原因。
- `#completeArguments()` 比较参数字符串的前缀与字面相等，不比较 JSON 值。
- [responses.ts](packages/bush-provider-openai/src/responses.ts) 捕获冲突后只返回统一错误码和文字，未保留冲突字段、之前的值、当前值或原始事件。兼容性诊断也不包含失败原始流。
- [assistantConversation.ts](packages/bush-runtime/src/assistantConversation.ts) 在失败时仅抛出错误文字，不把失败模型结果写入模型历史。手动重试会清空实例中的错误。成功轮次保存的 `providerReplay` 只属于成功响应，无法还原前一个失败响应。
- 已检索本机项目日志、用户配置目录日志、Runtime 事件/会话/检查点/工具执行/会话日志及相关压缩记录，未找到本次失败的原始流或冲突细节。不能用重试成功的参数替代失败参数作判断。

火山方舟的[工具调用事件文档](https://docs.volcengine.com/docs/ark/streaming-responses-tools?lang=zh)区分参数增量事件和完整参数事件。该文档不能说明本次未保存的失败响应实际包含什么。

## 已做的复现

使用同一配置发起 9 次隔离模型请求，捕获 SSE、请求正文和归一化事件；没有执行模型生成的任何工具，也没有改动真实会话或连接配置。未记录请求鉴权头。

- 前 6 次覆盖目录查询、原始用户问题及参数格式提示，均未复现错误。
- 另 2 次使用实际查询结果和失败前环境上下文、当前 Assistant 工具目录及内置提示词重建后续请求，均未复现。重建不是原失败请求的逐字节副本，未恢复所有当时的用户偏好/请求选项。
- 最后 1 次只开放 `summary_for_user`，覆盖空参数 `{}`；没有发生工具调用冲突，但响应达到了本次探测设置的输出上限，以 `response.incomplete` / `length` 结束，不能算作完整会话成功。
- 最后 2 次透传真实网络分块并旁路保存响应，避免只测试一次性缓冲正文。
- 离线重放上述 9 份流均没有 `provider_tool_call_changed`。
- 现有 `responsesAdversarial.test.mjs` 回归 49/49 通过，包含身份/参数冲突拦截、重复生命周期事件、真实 SDK 到 Runtime 的执行边界、截断和取消。日志为 `tmp/deepseek-tool-stream-regression.log`；这些通过结果不代表原故障已修复。

另外用人工构造的最小事件序列验证当前校验行为：

| 参数/身份变化 | 当前结果 |
| --- | --- |
| 增量、完成事件、终态快照一致 | 正常完成 |
| `{"expression":"curious"}` → `{ "expression": "curious" }`，只改空格 | `provider_tool_call_changed` |
| `curious` → `happy`，真实参数值变化 | `provider_tool_call_changed` |
| 参数不变但 call ID 改变 | `provider_tool_call_changed` |

**这证明当前比较对格式敏感，但不证明本次故障由格式变化造成。** 在线取样没有观察到这类变化，不能把人工构造的反例冒充原故障复现。

隔离脚本和取样结果位于本机忽略目录：

- `tmp/reproduce-deepseek-tool-stream.mjs`
- `tmp/deepseek-assistant-fixture.mjs`
- `tmp/deepseek-stream-probe-*/response.sse`、`request.json`、`normalized.json`、`summary.json`
- `tmp/analyze-deepseek-tool-streams.mjs`
- `tmp/deepseek-tool-stream-analysis.json`

## 后续修复的证据要求

继续定位需要捕获一次失败流，至少保留请求/响应标识、事件顺序、输出索引、冲突字段以及冲突前后工具调用数据。原始内容只能留在受控的本地诊断记录中，不应把密钥、鉴权头或完整会话输出到通用日志。

若证明仅为合法 JSON 的表示变化，再设计保持执行参数、历史和 provider replay 一致的等价处理，并覆盖重复键、数值精度、部分参数和真实值变化。若调用身份或参数值确实变化，则保留执行拦截，针对供应商流异常处理和恢复。没有证据前，不通过放宽校验或增加重试掩盖错误。

Assistant 和普通会话共用这个 Responses 解析器，因此比较规则的潜在影响不限于 Assistant；本次没有普通会话发生同样错误的证据。这次调查也没有证明此前的终态回执重复消费问题复发。

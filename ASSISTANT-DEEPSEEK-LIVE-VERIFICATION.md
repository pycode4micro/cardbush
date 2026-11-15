# Assistant 真实 DeepSeek 验证

后续已修复 clean 暴露与必需参数不配套的问题，并完成 Assistant 和普通会话的真实复验，见 [clean 模式修复与最终验证](ASSISTANT-CLEAN-MODE-FIX.md)。以下保留修复前的原始发现。

验证日期：2026-11-15，Asia/Shanghai。结论：**四次实测均未复现 loop 重复提交、重复派活、重复回复或重复完成通知；但“没有额外模型请求”不能全部通过，发现了工具参数错误引起的纠错轮次。**

## 模型与方法

- 使用本机默认模型配置 `deepseek-v4.1-flash`，火山引擎 `ark.cn-beijing.volces.com`，`openai_responses` 接口。原始响应中的模型为 `deepseek-v4-1-flash-261017`。
- 使用正式 `createProductAgentTurnRequest`、`runtime.assistant_conversation`、工具注册表、原有子任务执行器和 Provider。Assistant 与子任务均请求真实模型，没有模拟模型回答或工具回执。
- 每个场景使用独立的工作目录和 Runtime 数据目录。子任务通过真实 `read_file` 读取随机验证代码与数量/单价，完成通知必须包含文件中的验证代码及正确乘积。
- 为明确区分前台答复和异步通知，仅控制子任务第一次模型请求的开始时机：先完成 Assistant 前台答复，再释放子任务。等待期间检查没有模型轮询；完成后观察 8 秒；随后发送新的普通消息，再观察 8 秒，确认旧结果没有再次唤醒 Assistant。
- 同时保存 Runtime 模型请求/事件、实际 HTTP 请求/原始 SSE、工具执行、模型历史回执与可见聊天记录。记录不包含 API Key 或认证请求头。本机模型配置哈希保持不变。
- 两种场景原样运行两遍，没有为了得到成功结果修改提示词或业务代码。第二遍仅完善测试脚本的判定与统计。

## 请求与通知计数

下表中“前台”包含模型自己调用的 `summary_for_user` 收尾轮次；“后续消息”是用户另发的一次“只回复好的”。子任务的模型请求另列。

| 场景 | Assistant 前台 | 异步完成 | 后续消息 | 子任务 | 实际推理 HTTP | 派活执行次数 | 完成通知 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 第一次：普通派活 | 4 | 1 | 1 | 4 | 10 | 1 | 1 |
| 第一次：按需读取 | 5 | 1 | 1 | 3 | 10 | 1 | 1 |
| 第二次：普通派活 | 4 | 1 | 1 | 3 | 9 | 1 | 1 |
| 第二次：按需读取 | 4 | 1 | 1 | 4 | 10 | 1 | 1 |

合计 39 次推理 HTTP 请求，全部返回 200；每次 Runtime 模型调用恰好对应一次推理 HTTP，没有传输重试、重复请求体或额外的完成请求。另有 4 次独立的 `responses/input_tokens` 能力探测返回 404，Provider 回退到本地 token 估算；它们不是模型生成请求。每个场景从独立的 Provider 能力缓存开始，因此各探测一次。

每个场景的可见消息均是：一次派发确认、一次包含真实结果的完成通知、一次对后续用户消息的答复。每个模型工具调用 ID 只有一份回执，完成结果在模型历史中仅消费一次。普通派活没有读取 schema；按需读取均只读取一次 schema，并成功使用 `call_tool` 传递 clean 模式及独立系统指令。

## 暴露的问题

### 1. 普通派活连续两次出现配置字段不完整

两次第一次调用均选择 `mode: "clean"`，却没有 `system_prompt`，被拒绝：

```text
tool_arguments_schema_invalid
clean mode requires a non-empty system_prompt.
```

模型读到失败回执后改用普通 fork 派活，因此各多出一轮模型请求。失败发生在真正派活之前，没有创建第二个任务。

共享精简定义仍暴露 `mode` 的 `fork/clean` 两个选项，却省略 clean 所需的 `system_prompt`。描述要求高级配置先读取完整定义，但这两次 DeepSeek 都直接选择了可见的 clean 选项。这是精简定义中选项和配套参数暴露不一致的实际风险，不是完成回执二次消费。

相关位置：[精简定义投影](packages/bush-runtime/src/subagentTool.ts#L235)、[完整字段定义](packages/bush-runtime/src/subagentTool.ts#L226)、[参数校验](packages/bush-runtime/src/subagentTool.ts#L683)。这套投影与普通会话共用，因此普通会话也有相同定义风险；本轮没有用真实模型另跑普通会话。

### 2. 第一次按需调用自行增加未声明字段

完整 schema 已成功读取，包含 `system_prompt`、`allowed_tools`、`settings` 等字段，不包含 `guards`。DeepSeek 第一次封装调用仍添加了 `guards: ["read_only"]`，被拒绝：

```text
tool_arguments_schema_invalid
unsupported subagent arguments: guards
```

模型去掉该字段后成功派发，所以前台是 5 次而非 4 次请求。第二遍同样场景没有出现该错误，前台为 4 次。这里是模型生成了 schema 外字段，完整定义的读取和传递没有缺失，也没有重复执行成功的调用。

### 3. 子任务也可能发生参数纠错

第二遍按需场景的子任务第一次调用 `summary_for_user` 时添加了不存在的 `summary` 字段，被校验拒绝，改正后成功结束。因此该子任务用了 4 次请求，而非该场景首遍的 3 次。异步通知仍只有一次。`summary_for_user` 的实现、定义与提示词未修改。

## 如何解读“没有多发请求”

运行时检查通过：没有相同推理请求二次提交、成功操作重放、等待期间轮询、完成结果重复消费或重复可见回复。

零纠错轮次检查未全部通过：上述参数错误确实增加了真实推理请求，不能算成“完全没有多余开销”。在本次模型遵守收尾规则的路径下，普通派活的基础前台序列是 `subagent → summary_for_user → 最终回复`（3 次）；按需路径是 `get_tool_schema → call_tool → summary_for_user → 最终回复`（4 次）。此前固定模型响应回归中的 2 次/3 次计数不包含模型自主选择的收尾调用，不能直接当作真实模型的总轮数。

后续可以收紧共享精简定义中 clean 模式的暴露方式，使需要独立系统配置的调用明确走完整定义。模型凭空添加字段的问题应继续保持严格校验，不能通过静默删除字段、自动补参数或绕过校验来伪造通过。本轮仅验证和记录，没有修改业务代码。

## 复现与原始证据

运行入口：[scripts/live-assistant-tool-disclosure.mjs](scripts/live-assistant-tool-disclosure.mjs)。必须显式 opt-in，会真实消耗所选模型的额度：

```powershell
node scripts/live-assistant-tool-disclosure.mjs --run
```

默认读取本机默认 DeepSeek 配置；可通过 `BUSH_LIVE_MODEL_CONFIG_PATH`、`BUSH_LIVE_MODEL_ID` 选择另一份本地配置或模型。测试产生的文件均留在独立的 `tmp/assistant-deepseek-live-*` 目录。

- [第一次原始记录](tmp/assistant-deepseek-live-2026-11-15T06-30-04-642Z/verification.json)
- [第一次完整证据复核](tmp/assistant-deepseek-live-2026-11-15T06-30-04-642Z/verification-reviewed.json)
- [第二次原始记录](tmp/assistant-deepseek-live-2026-11-15T06-33-20-877Z/verification.json)
- [第二次完整证据复核](tmp/assistant-deepseek-live-2026-11-15T06-33-20-877Z/verification-reviewed.json)

原始记录保留运行当时的初版测试判定：第一遍普通派活曾只按运行时检查判为成功；第二遍按需场景曾只检查父 Assistant 参数错误而判为成功。复核文件加入了全部参数错误及子任务失败回执，本文以完整证据复核为准，没有覆盖原始记录。脚本已同步收紧判定，后续遇到这些错误会报告未通过。

证据文件在本机忽略目录中，不随 Git 自动提交。测试覆盖本地 Runtime 的有限样本，不代表所有模型行为或远程部署组合均已验证。

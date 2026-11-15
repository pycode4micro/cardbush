# clean 模式定义修复与真实验证

2026-11-15，Asia/Shanghai。共享精简定义和系统规则已修正；最终选取的 Assistant、普通会话共四个真实 DeepSeek 场景全部通过，没有 clean 参数纠错、重复派活或重复结果交付。`summary_for_user` 的定义、实现、记忆逻辑和收尾提示词未修改。

## 修复

原来的精简 `subagent` 定义保留 `mode: fork/clean`，却省略 clean 必须提供的 `system_prompt`。DeepSeek 两次选择 clean 后均因缺少系统指令而重试，产生额外模型轮次。

- [共享定义投影](packages/bush-runtime/src/subagentTool.ts#L235)移除精简入口中的 `mode` 字段。普通临时派活省略配置，沿现有默认 fork 行为执行；已登记员工仍可直接通过 `agent_id` 使用其完整配置。
- 新建独立 clean 子代理继续走现有 `get_tool_schema → call_tool`，完整定义同时提供 `mode`、`system_prompt`、`allowed_tools` 和 `settings`。缺少按需读取入口时仍提供完整定义，不丢失 clean 能力。
- [共用系统规则](assets/prompts/coordination-tool-boundaries.md)明确普通派活默认、clean 必需参数及按需调用边界。Assistant 与普通会话使用同一模板。传入的 `system_prompt` 仍由原有机制注入子任务的 system 消息，未自动生成或补填缺失指令。
- clean 实测还遇到模型将员工注册的 `agent.guards` 错放到临时派活顶层。共用规则补充了字段归属：员工定义字段用于 `action=save`，角色指令进入 `system_prompt`，明确的工具限制使用 `allowed_tools`。执行层仍拒绝未声明字段。

生产执行器、loop、结果消费和权限机制没有新增分支。此次生产改动是共享投影字段选择及共用提示词。

## 回归与构建

136 项相关测试通过，覆盖：

- Assistant 和普通会话的实际入口均使用精简定义及共用系统规则。
- 精简入口不暴露缺少配套配置的 clean 选项；完整读取保留 clean 和必需的系统指令。
- 普通会话和 Assistant 的 clean 系统指令确实进入子任务的 system 消息。
- 普通派活只执行一次，clean 仅增加正常的定义读取轮次，结果通知只消费一次。
- 已登记员工、完整定义回退、调用权限、回执、终态通知和工具排序继续有效。

测试中保留完成状态断言，并将已完成任务的查询改为 `scope=all`；默认活跃列表另断言不再包含该任务，符合现有任务查询语义。

`npm run build`、`npx tsc --noEmit -p tsconfig.json` 和 `npm run test:app-views` 均通过。界面首次运行在已有的 `quick-context-motion.cjs` 悬停切换时序断言失败，未修改组件或断言，完整复跑通过。提示词快照只更新本次修改的模板，ESM/CommonJS 打包一致性验证通过。

`individuationTools.ts`、`assistantMemory.ts`、`assistant-memory.md`、`final-response-signal-instructions.md` 与本轮开始时的文件哈希一致。

## 真实 DeepSeek 最终结果

沿用本机 `deepseek-v4.1-flash` 配置及 Responses 接口。使用真实父模型、子模型和文件工具，在隔离目录读出随机验证代码与数量/单价；没有模拟回答或回执。

| 入口与场景 | 结果到达前的父模型请求 | 结果到达后的父模型请求 | 新用户消息 | 子模型请求 | 推理 HTTP 总数 | 参数错误 | 子任务数 | 结果交付 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Assistant 普通派活 | 3 | 1 | 1 | 4 | 9 | 0 | 1 | 1 |
| Assistant 按需 clean | 4 | 1 | 1 | 3 | 9 | 0 | 1 | 1 |
| 普通会话普通派活 | 3 | 3 | 1 | 2 | 9 | 0 | 1 | 1 |
| 普通会话按需 clean | 3 | 4 | 1 | 2 | 10 | 0 | 1 | 1 |

Assistant 的基础前台序列为 `subagent → summary_for_user → 回复`；clean 路径在前面多一次 `get_tool_schema`，再由 `call_tool` 执行。此前普通派活因 clean 缺少参数而增加的纠错轮次已经消失。

普通会话是通用执行 Agent，模型在子任务返回后额外读取原文件核对，有时调用 `remember_source`，所以完成阶段的请求数高于 Assistant；这些是原始响应中明确生成的工具调用，不是 loop 重复提交。普通会话普通派活还在两个不同阶段各调用了一次 `summary_for_user`，中间发生了新的文件核对工具工作；该机制未修改。

最终四个场景合计 37 次推理 HTTP，均返回 200，每次 Runtime 模型调用对应一次 HTTP 提交，没有相同推理请求体重复提交。另有四次 `input_tokens` 能力探测返回 404，随后使用本地估算，不计为模型生成请求。

每个场景的实际任务和完整结果均只有一份；结果含真实文件中的验证代码及正确乘积。完成后观察 8 秒没有新请求或重复回复；再发送一条普通消息，只增加一次模型请求，旧结果没有重新交付。

## 普通会话测试边界

Assistant 实测控制子任务第一次模型请求的开始时机，用于明确验证“前台答复以后只通知一次”。普通会话的子任务正常立即运行，使用当前轮次委派；`run_in_background=true` 的跨轮后台任务属于另一种交付语义，本次没有修改它。

验证过程中修正了普通会话测试驱动的两个假设：不能等最终显示标记再释放子任务；模型也可能主动通过 `tasks` 消费完成结果。后一种情况下没有额外异步通知才是正确行为，最终脚本核对“前台结果回执 + 异步结果消息总共一次”。中间记录保留，没有更改 Runtime 去适配测试。

最终普通派活再次完整执行并验证了静默观察和后续消息；按需 clean 场景也独立完成。表格只统计这些完成全部检查的场景。模型主动复核文件等行为会改变轮次，这次验证不能保证未来任意模型输出都不会写错参数。

## 证据与复现

- [最终证据汇总](tmp/assistant-clean-mode-final-evidence.json)
- [Assistant 普通派活](tmp/assistant-deepseek-live-2026-11-15T07-02-09-890Z/ordinary/verification.json)
- [Assistant 按需 clean](tmp/assistant-deepseek-live-2026-11-15T07-02-09-890Z/on-demand/verification.json)
- [普通会话普通派活](tmp/assistant-deepseek-live-2026-11-15T07-13-21-258Z/chat-ordinary/verification.json)
- [普通会话按需 clean](tmp/assistant-deepseek-live-2026-11-15T07-10-18-177Z/chat-on-demand/verification.json)

同目录保存 `model-*-request.json`、模型事件、`http-*-request.json` 和原始 SSE。凭据和认证头不写入记录；真实配置和用户历史未被测试修改。原始证据位于本机忽略目录，不随 Git 自动提交。

[真实验证脚本](scripts/live-assistant-tool-disclosure.mjs)默认跑两个 Assistant 场景；以下命令增加普通会话，会真实消耗模型额度：

```powershell
node scripts/live-assistant-tool-disclosure.mjs --run --with-ordinary-chat
```

也可以用 `--cases=ordinary,on-demand,chat-ordinary,chat-on-demand` 选择其中的场景，避免重复已完成的测试。

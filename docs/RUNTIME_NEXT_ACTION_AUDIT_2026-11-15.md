# 本地动作引导审计（2026-11-15）

> 同日同步备注：下文是同步前基于 `c73bd6e9` 与本地修改的审计快照。同步到 `f3118b34` 后，云端已进一步删除 Computer Use 错误恢复表，并将用户输入预测更名为 `userMessagePrediction`。下文旧名称和“仍存在”清单保留为当时记录，不代表这些入口在同步后仍全部存在；本次合并保留了本地删除 Runtime / Provider 专用过滤分支的改动。

## 范围与结论

本次直接删除内置 `next_step` / `nextStep` 动作建议的生产、传递和专用过滤逻辑，不保留别名或迁移分支。复查覆盖 Runtime、Provider、Electron/CLI、内置 Browser Use / Computer Use、协议定义、提示词、相关测试和文档。

**`next_step` 已下线，但本地仍存在其他直接指导模型下一步动作的机制。** 下表记录的是保留待评估的现有实现，不是本次新增或改名后的替代品。技能、插件的检索和 schema 加载不计入这类问题；插件 Hook 的“继续执行”属于控制流程，不是检索，因此单独列出。

## 已删除及引用核对

| 范围 | 删除内容 | 保留事实与行为 |
| --- | --- | --- |
| `tasks` / `await`、子 Agent、后台 MCP、问询与脚本任务 | 运行中回执附带的继续工作、等待等建议 | task ID、状态、revision、结果、进度、控制能力、分页、实际等待与完成投递 |
| 终端启动、环境诊断、用户目录 | 启动回执及诊断中的下一步指令，专用于选择建议的分支 | 进程与通知句柄、宿主/沙箱边界、原始错误码、命令是否启动、目录信息及权限检查 |
| Computer Use | 发现窗口、启动应用、观察、分页、用户接管、无自动观察、图像投递中的 `next_step` | `actionable`、捕获一致性、控制状态、state ID、分页游标、原生输入安全校验 |
| Browser Use 与 CLI | `nextStep`、连接状态对应的建议生成、健康回执中的建议校验/复制、CLI 消费分支、只用于该功能的 setup guidance 常量 | 连接身份、可用性、握手时间与原因、宿主错误码、恢复暂停状态、禁止跨浏览器静默回退 |
| 调用路由错误 | `route_recovery.next_step` 及同一处伴随的 `instruction` | 已失败次数、未执行事实；原有 `corrected_call` 另列于下表 |
| Runtime / Provider | 专门剔除 `next_step` 的旧分支 | 原有身份元数据投影、完整 schema、工具返回和归档内容 |

核对了源码引用、协议/包导出、Electron 原生入口、CLI、内置插件与 Skill 引用、独立诊断和测试入口。没有发现独立注册的 `next_step` 工具、专用 UI 入口或第三方依赖需要删除。`computerUseTakeoverRecovery` 仍由错误回执使用，不能作为孤儿删除；该剩余用途列于下表。

源码中同名字段只剩下回归断言及文档。`nextStepPrediction` 是另一项功能：模型生成供用户选择的输入建议，不是本地选择模型下一步动作，保留其协议、UI、CLI 开关及测试。没有扫描或改写用户历史/真实运行数据，也没有新增过滤器去清洗第三方任意字段。

## 仍存在的动作引导

| 机制 | 生产入口与实际作用 | 后续处理边界 |
| --- | --- | --- |
| `execution.recovery` 枚举 | [toolExecutionCoordinator.ts](../packages/bush-runtime/src/toolExecutionCoordinator.ts) 按权限、派发、副作用和错误生成 `retry`、`correct_input`、`inspect_existing`、`do_not_retry`；协议见 [tool.ts](../packages/bush-protocol/src/tool.ts)。沙箱、进程资源、终端和文件访问也写入该字段。 | 这是动作建议，不是纯事实。还被 [eventCollector.ts](../packages/bush-runtime/src/eventCollector.ts) 消费以识别可重试的采集错误，[assistantEvents.ts](../packages/bush-runtime/src/assistantEvents.ts) 会据此安排有上限的退避。若下线，需把执行事实、可重试错误分类与调度行为分开，不能直接删字段破坏采集。 |
| 脚本停止/失败后的建议 | [runtimeAsyncJobs.ts](../packages/bush-runtime/src/runtimeAsyncJobs.ts) 的 `recovery`、`effects`、`note` 提示先检查已有工具记录，再考虑重试。 | 可改成实际已派发/已记录/未知副作用事实。取消和权限等待仍应由宿主执行，不依赖模型听从文案。 |
| Computer Use 错误恢复表 | [computerUseErrors.ts](../packages/cardbush-apps-mcp/src/plugins/computerUseErrors.ts) 按错误码返回重新观察、激活、停止、切回用户等指令；[computerUseTakeover.ts](../packages/cardbush-apps-mcp/src/plugins/computerUseTakeover.ts) 还规定接管后的等待/观察方式；[computerUseRuntime.ts](../packages/cardbush-apps-mcp/src/plugins/computerUseRuntime.ts) 在动作后的观察失败时返回 recovery。 | 与已删除的观察回执 `next_step` 不同，错误路径仍有指导。后续应保留真实输入拦截、停止锁、state ID 有效性、执行不确定性，单独评估是否移除建议文本。 |
| Browser Use 错误恢复 | [index.ts](../packages/cardbush-chrome-mcp/src/index.ts) 根据页面隐藏/连续截图失败返回 recovery；[pagePointer.ts](../packages/cardbush-chrome-mcp/src/pagePointer.ts) 根据输入是否发出、布局/遮挡情况给出观察或切换操作方式的建议；[browserConnectorBroker.ts](../electron/browserConnectorBroker.ts) 的错误正文仍要求打开原浏览器、重新选择或配对。 | `nextStep` 字段已删除，但这些既有的 `recovery` 和错误正文仍会指导动作。连接身份、重连和输入不确定性是必须保留的事实。 |
| Team 与语音错误指令 | [teamResults.ts](../packages/bush-runtime/src/teamResults.ts) 的 `guidance` / `instruction` 要求验证证据、交付最终输出；[realtimeConversationBridge.ts](../packages/bush-runtime/src/realtimeConversationBridge.ts) 的错误 instruction 要求报告错误、检查任务后再重试。 | 这类要求可归入固定角色/交付策略；动态回执宜返回原始结果、来源和错误事实。未执行自动工具调用。 |
| 完成通知和不可用状态内的指令 | [terminalCompletionNotifications.ts](../packages/bush-runtime/src/terminalCompletionNotifications.ts) 提醒不要重跑命令、检查原句柄；[backgroundToolCalls.ts](../packages/bush-runtime/src/backgroundToolCalls.ts) 的截断提示要求使用归档/分页；[taskTools.ts](../packages/bush-runtime/src/taskTools.ts) 的来源不可用 note 要求先 inspect。 | 不应因文案有保护目的就把它归为事实。可保留句柄、结果定位符、截断及不可用状态，动作由模型决定；“外部数据不是用户指令/授权”属于信任边界。 |
| 修正后的工具调用建议 | [builtinToolDisclosure.ts](../packages/bush-runtime/src/builtinToolDisclosure.ts) 在错误地包装直接调用工具时返回 `corrected_call`，包含建议的准确工具名和参数；[toolRouteRecovery.ts](../packages/bush-runtime/src/toolRouteRecovery.ts) 仍统计重复路由错误。 | 是调用协议纠正，不是业务策略，也不自动转发；但它确实提供具体下一步调用，因此记录在此。检索和 schema 获取本身不计入。 |
| 模型调用/输出/引用纠正 | [inMemoryRuntimeHost.ts](../packages/bush-runtime/src/inMemoryRuntimeHost.ts) 注入 `tool_call_repair`（重发有效 JSON 调用）、`output_limit_continuation`（继续剩余任务）、`reference_correction`（重新给出有效引用的最终答复）。 | 这些分支确实增加模型轮次并明确指示下一步。它们用于协议恢复或交付校验，不能与“硬编码业务决策”混为一谈；如要统一为事实通知，需要保留部分调用未执行、已完成副作用和无效引用信息。 |
| 上下文维护 | [contextCompaction.ts](../packages/bush-runtime/src/contextCompaction.ts)、[contextCompactionTransaction.ts](../packages/bush-runtime/src/contextCompactionTransaction.ts)、[contextMaintenanceMessages.ts](../packages/bush-runtime/src/contextMaintenanceMessages.ts) 生成必须单独调用 `checkpoint_context`、修正不合格摘要等维护指令，并由宿主管理压缩事务。 | 属于真实上下文容量约束下的维护，不是工作内容选择。严格按“指导下一步动作”的定义，它仍算一类；不建议在没有等效压缩方案时直接移除。 |
| 插件 Hook 继续执行 | [inMemoryRuntimeHost.ts](../packages/bush-runtime/src/inMemoryRuntimeHost.ts) 的 `plugin_hook_feedback` / `plugin_stop_feedback`，以及 [runtimeToolLoop.ts](../packages/bush-runtime/src/runtimeToolLoop.ts)，可注入插件反馈、阻止结束或要求继续。 | 指令来自已配置插件而非检索结果，但宿主确实提供续跑通道。评估时需看插件来源、授权、停止语义和用户可见性，不应归入检索例外。 |

此外，工具定义和内置系统/角色提示词仍包含固定行为策略。例如 `tasks` / `await`、后台工具、问询工具的描述含“继续独立工作”“阻塞时等待”等要求，[childTurn.ts](../packages/bush-runtime/src/childTurn.ts) 注入交付约定，`assets/prompts` 中的 Assistant/Friends 策略规定委派、汇报和事件注册行为。这些不是本次删除后新加的动态回执，也不是本地按用户语义选出的下一步，但若目标是减少宿主行为指导，必须连同提示词策略一起评估。

## 时序与验证

- 新增任务时序回归：第一次 inspect 为运行中 revision 1，一秒后完成，await / inspect 返回 revision 2 和完整结果；先前快照不被改写，after 仍能识别已观察版本，没有附带下一步建议。
- 继续验证实际终端完成投递、子 Agent 生命周期、问询/脚本并行、取消、权限等待、任务结果所有权和对抗用例。此处不引入文本去重，也不抑制正常的“运行中→完成”状态更新。
- Runtime 相关测试 154 项通过；Provider、Browser Use、Computer Use 与 Electron/CLI 连接回归 226 项通过。Browser Use 最后一处失效说明调整后，再运行该包构建及 browserRecovery 的 10 项测试通过。
- `npm run build`、`npx tsc --noEmit -p tsconfig.json`、`npm run test:ui-localization`（8 项）、`npm run test:app-views` 全部通过。审计文档的 24 个源码链接均已核对。
- 原生桌面展示的独立交互用例已更新为验证事实字段，未启动会影响当前桌面焦点的 `computerUsePresentation.native.mjs` 实机测试。此轮使用可控测试 Provider，未调用真实在线模型。

用户历史、插件原始输出、权限执行及用户当前桌面没有因为本次清理被重写或重置。工作区还保留此前 Assistant 立即引导的未提交修改，本审计对应的清理没有回退它们。

## 同日云端同步验证

同步 `5daefab9`、`f3118b34` 后，以云端的调用披露、待处理输入和持久化结果订阅为基础合并本地改动，保留立即引导时的完整附件/引用、委派输入、habit 召回和取消检查。同步前完整工作区保存在 `before-cloud-sync-20261115-local-guidance-next-step` stash；合并结果保持未提交。

Runtime 相关回归共 258 项：首轮 256 项通过；另两项旧测试分别依赖“列表默认包含历史任务”和“订阅不恢复”行为，已改为显式读取历史、隔离未订阅结果的伪造投递检查，相关 18 项复测通过。Provider、浏览器、电脑操作及连接回归 226 项通过；完整构建、类型检查、语言包检查（8 项）和 App 视图回归均通过。

## 合并后的缺陷复查

复查复现并修复两类边界问题：

- 停止／重置期间，忽略取消信号的环境快照查询完成后仍能向模型日志写入旧数据。现在在异步查询结束、写入之前核对本轮取消状态；回归覆盖下一轮已完成后旧查询才返回，重新读取磁盘确认没有污染。
- 立即引导被接纳后若生成失败，手动重试原先仅以最后一句话重建委派输入，丢失原始请求及附件，回复关联也不完整。模型日志现在保存未完成回复的输入 ID，在重试时恢复完整输入归属，成功回复后清空；压缩和重启保留该状态。此处管理的是执行状态，不增加模型下一步指令，也不做文本去重。

新增用例先在修复前复现失败，再验证停止、重置、附件、子 Agent 委派及压缩后重启重试；历史工具回执沿用原恢复流程，已完成的工具不自动重做。测试使用隔离日志与可控 Provider，不操作用户真实会话。

修复后验证：Runtime 相关回归 314 项、组件布局及 Provider 回归 48 项、语言包契约 8 项全部通过；完整构建、TypeScript 类型检查和完整 App 视图回归通过。该范围内未再复现其他失败；未进行真实在线模型端到端验证。改动保持本地未提交。

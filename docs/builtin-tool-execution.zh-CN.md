# 内置工具执行

[English](builtin-tool-execution.md) · [简体中文](builtin-tool-execution.zh-CN.md)

Registry 是能力权威目录，Provider 定义只是展示，不是授权。包括脚本内嵌调用在内，每次都经过 `ToolExecutionCoordinator` 的作用域、子任务策略、MCP 发现、权限、Hooks、结果校验及日志。

## 默认入口

| 需求 | 工具 |
| --- | --- |
| 命令 / stdin | `terminal_exec/terminal_write` |
| 精确读写 | `read_file/edit_file/write_file` |
| 多文件关联修改 | `apply_patch` |
| 终端、子任务、Team、MCP、提问、脚本观察 | `tasks` |
| 询问并继续独立工作 | `request_user_input_async` |
| 过滤、转换、串联结果 | `run_tools` |
| 读取完整原生/MCP 定义 | `get_tool_schema` |
| 调用已加载业务工具 | `call_tool` |
| 搜索 MCP 名称 | `mcp_search` |

`subagent` 分派个体，`team` 管保存流程及启动/恢复，`tasks` 负责观察、指定 `node_ids` 结果、等待/停止、子会话读取。编辑 Team 先加载完整定义，加载本身不扩权、不改顶层声明。

`call_tool` 以目标名进入原协调器，复用校验、权限、Hook、资源锁、调度、取消、结果及 UI/日志，wire call/result ID 不变，不是第二个后台执行器或脚本。发现、归档读取、上下文维护仍直接调用，保留回执语义。

发现和调用分别检查：`get_tool_schema` 恰好 `name/names` 二选一（最多 16），覆盖原生和 MCP；`mcp_search` 只搜索。完整回执为 `bush.tool_schema.v1`，含来源/修订，共用归档验证。必须读到完整定义再调用，并行“加载+调用”不满足此前提。脚本经 `run_tools → tools.call`。

已退役的 `mcp_call/parallel_tools/manage_tool_calls/manage_plugin_agents/await_subagents/read_subagent_conversation/solution_selection/request_permission` 不再注册或提供旧结果适配；旧 `mcp_search action=load` 拒绝。产品策略 v9 在执行前拒绝不兼容历史合同，不迁移重放。显式历史清理可删除会话、执行及恢复状态，保留配置/插件/项目文件。

错路由或包装直接入口返回带原参数的 `corrected_call`；重复相同错误从已有回执给针对性入口检查，不反复塞完整 schema。这只是下一步建议，不自动转发/重放，不猜别名，仍需发现/作用域/授权/Hook。原生和 MCP 业务工具共用 `call_tool`。

默认目录稳定，不按用户文字猜工具子集；低频小工具与 `update_task_plan` 仍可用，不另建内置搜索。空 Command 目录只在首次投影隐藏 list/run_plugin_command，Skills 保留。turn 工具投影冻结；安装变化刷新执行作用域并追加通知，通过发现/调用使用新增或修订能力，删除的仍拒绝。未知状态不等于空目录，显式命令、Hook、历史调用保留原处理器/范围；子任务权限在准入控制，保留 fork 前缀。

普通发现、重复加载、Skill 读和分页只追加结果。Responses 原生发现 schema 真变化才完整回放一次去冲突；这不同于重复读同定义。显式工具/模型/system 改动或压缩可能让旧 Anthropic thinking 签名失效；适配器记录新投影，省略不兼容推理而保留文字/结果，仅明确旧前缀绑定拒绝才允许一次修复，普通 400 不触发，持久历史不改。

## 策略、摘要与来源

固定 system 管语言/风格、授权、等待期间独立工作、验证和交付；工具定义管参数及回执，不在 system 重复工具手册。工具工作结束、最终回复前单独调用 `summary_for_user` 标记终轮展示；没有新记忆或记忆关闭用 `{}`，habit/prediction 独立开关。纯对话无需调用；其后又有工具/用户引导则需重新标记。这是提示指导，不是宿主完成闸门，不额外要求摘要或模型总结轮；普通压缩从已有执行记录与终轮回复推导。

首次分派记录 `model_contract_bound`（system/Provider 定义），继续、重启和 fork 复用。产品声明的版本迁移可在 turn 边界追加 `model_contract_updated`，验证旧版本后只刷新点名定义，不改活动 loop；合同不出现在侧栏/历史摘要。匹配合同跨重启冻结，不匹配要求新会话；加载不会删除或重写原会话。实时权限/处理器仍逐调用核对。

checkpoint 的 Markdown `summary` 保留 `<skill_constraints>`，每条约束写适用条件及来源行链接，延迟引用说明何时/为何读。一次性已完成动作保留真实任务/产物 ID。模型判断适用性，Runtime 仅校验路径、已观察版本和交付范围，不靠关键词退休规则或另建 keep/retire JSON。

`read_file/run_skill` 共用来源收集，保存实际解析字节 hash 和确实交付的原文字面行；参数展开、命令输出、激活说明、fork 结果不冒充原文件行。最终截断只计算完整可见行，省略尾部保留归档定位，发现不算读取。格式：`[适用条件或重读原因](<absolute/path?revision=SHA256#L12-L18>)`；只有一个已观察版本时可省 revision，但回执仍绑定 hash。重读后核对版本再复用行号。紧凑回执只保留选定范围/元数据，原文件和工具档案保持原处，不改system/顶层工具，不新增 remember 文件。离线测试验证传输与已写 handoff，不证明模型概括语义完全保真。

## 诊断、任务与提问

`cache_chain_observed.payload.toolDefinitions` 记录实际工具数、JSON 字符量、描述/schema 分量、排除扩展后的内置量及最大五项，不复制正文/schema/用户内容，也不注入模型。`estimatedTokens` 是 `runtime-tool-json-chars-v1`（JSON 字符/4 向上取整），不是 Provider 用量/账单，wire 格式可能不同。节省评估需结合请求数和结果质量。

起始回执沿用句柄：Team/异步提供 task_id；终端可用 session ID 或完成通知 ID；子任务 taskId 原样进 task_ids。`tasks` 支持 list/inspect/conversation/wait/stop/cancel_observation，列表有界、优先待处理、不带结果；`after` 携每任务修订，省未变化正文。源不可用独立报告，不隐藏别源，状态读每源 1 秒截止。

普通等待默认 1 秒，0 为快照，最多 30 秒，可等 any/all 或被用户引导唤醒；取消等待/超时不停止执行器。cancel_observation 只取消完成订阅，终端事实仍来自进程；stop 走执行器取消与原终端权限，不支持的控制明确报告。[远程子任务](SUBAGENT_REMOTE_PROTOCOL.zh-CN.md)另有所有权绑定的观察/消息/停止协议。

问题复用本 turn 持久 broker，立即返回，共用任务观察和结果投递；真实选择/文字答案才解决依赖，关闭/取消不授权。每会话同时一组问题，文字最多 500 Unicode 字符、建议答案每项 120。

计划等待节点保存 `status:waiting`、具体 `waitingFor` 和 `waitingKind:user|background|dependency`，流/恢复/历史同样持有。只有 user 触发注意通知，被动等待中性；旧未分类状态不从文字猜人类动作。恢复/完成清等待字段，只改原因不带类别则清旧类别。多等待优先明确用户输入，未答问题不能被被动计划隐藏；更新计划不强迫额外模型轮。

## 调度、失败与恢复

mutating、parallelSafe、resources、nestedCallable 各自独立，只读并发不能只看 parallelSafe。普通批次合并相邻安全调用，危险调用形成屏障。文件按规范路径读写租约，独立路径/多个读可并发，远程写在未提供规范资源身份前按连接保守互斥。终端输出按句柄协调，取消观察不释放仍活动执行器租约。

`call_tool` 调度使用实际请求中解析的目标通道，包括并发权限的桌面显示抑制；该提示不授予权限/schema。MCP 经同一资源调度器租 server：不安全独占，明确 parallel-safe 最多 8 个共享，不同 server 独立；直接/嵌套/后台共用，持续到执行器结束。资源/server 租约一起获取，排队项分派前复查注册和 Hook stop，readOnlyHint 单独不足以并发。

执行及错误记录包含 `dispatch`（未启动/处理器启动/返回）、`effects`（无/可能/已记录改动）、`result`（已知/未知）、`recovery`（无/重试/改输入/检查已有工作/勿重试）。委派保留嵌套效果及授权，不确定修改不因 HTTP 状态而重放，失败优先显示恢复信息，完整原生结果在档案。

内部 `withToolFailureFacts` 通过进程内关联提供验证事实，不信错误文字或序列化 details.execution。实际改动/嵌套不确定优先。patch preflight 拒绝可报无效果、已知、改输入；触及写入即保守，包括回滚后。取消仍只能证明停止观察，不能证明执行器已停。

## MCP 状态与 SSH

`list_mcp_servers/list_plugin_connections` 默认 summary：配置 ID/修订、健康/错误/pending/toolCount，省批量名称及编辑设置。serverId 精确筛选，matched:false 只是未在观察中发现，不代表不可用 Runtime 已成功检查；禁用保存项仍可见，runtime:null/错误保留。`detail:true` 最好指定 serverId/pluginId 才读完整名称及脱敏设置。全局进度仍全局，service updateState 只描述所选服务；模型简表不是完整原生协议，UI/权限/生命周期仍用全数据。

SSH 以会话所选目录为准，连接默认目录仅供浏览。Windows `C:\Users\111` 与 SFTP `/C:/Users/111` 同身份；虚拟 `/` 可浏览但不是 Shell cwd，UNC/device/盘符相对路径拒绝。首次活动连接用有限只读探测查平台，文件仍 SFTP 不需 shell。Windows 用 PowerShell/cmd，POSIX 保留原 shell/process-group；省略 shell 用远端默认，未知/不匹配/断线不落本机也不重放。平台为执行数据，不动态改模型合同。

Windows 短 bootstrap 经 stdin 传宿主前导及用户命令，保留长/Unicode/引号路径，先拥有命名 Job Object 再释放用户代码。后代继承，stop 查 job 已空，不只关 SSH/PID。失败/断线保持未知；这是生命周期非 OS 沙箱，外部服务非普通后代。两端保留准确 command/shell/cwd 审批、owner 句柄、根目录删除保护、输出限额和现有沙箱限制；强制隔离在接桥前拒绝直接 SSH，不能无声忽略扩展。search/Git 复用平台启动/转义。`npm run test:ssh` 用本地 SSH/SFTP fixtures 和 Windows 子进程，不碰用户主机/模型。

## Patch 与脚本

`apply_patch` 使用 Begin/End Patch、Add/Update/Delete、可选 Move to、准确 @@；现有修订必须先读。授权/锁全部目标并在写前校验，歧义/重复路径不改文件；后续 I/O 失败尝试回滚并保留残余证据。这是预检+补偿，不是跨文件系统原子事务。上限 64 文件、2 MiB patch、32 MiB 暂存前后内容、单文件 8 MiB。SSH 仍用路由后的单文件工具。

`run_tools` 在独立 QuickJS/WASM heap 执行 async 函数体，提供 tools.NAME、tools.call、JSON/JS 转换，无 Node、文件系统、网络、timer/import：

```js
const file = await tools.read_file({ path: 'records.json' });
return JSON.parse(file.content).sort((a, b) => b.sales - a.sales).slice(0, 10);
```

脚本是 turn 拥有的后台任务，脚本 await 不阻塞模型做下一项独立工作。嵌套调用各有普通日志；安全调用可并发，同通道不安全调用有序，依赖写必须 await。

预算：代码 64,000 字符、32 调用、同时准入 8、guest 内存 32 MiB、总 CPU 1 秒（250ms slice）、含排队墙钟 5 分钟、最终序列化 2 MiB。第九个在总预算内排队，脚本槽与通道租约一起拿，避免忙通道占满槽；准入先于嵌套 Hooks/授权，取消/Hook stop 留未分派回执。可用 Promise.allSettled 保留部分成功并逐项检查，成功不自动重放；成功结束前排空未 await 操作，失败/取消可能已有副作用，重跑先看记录。初始脚本句柄返回后嵌套 Hook 仍能停止父 turn。

回归：`unifiedToolSystem.test.mjs/builtinToolDisclosure.test.mjs/builtinToolInvocation.test.mjs`、Provider 的 `anthropicProgressiveTools.test.mjs`，以及既有 tasks/journal/permissions/Team/workspace/MCP/model-loop；Anthropic 用真实 SDK+模拟 HTTP/SSE 验证跨编辑/工具/后续 turn 的前缀。

# 内置 Team 与注册员工

Team 是 Runtime 内置能力，入口位于原 Team 页面和输入框的 `/team` 选择器，无需安装插件。主 Agent 和本地文本 assistant 都能管理员工和发起团队任务；通话继续使用原有轻量委派接口。

## 三个边界

| 组件 | 责任 |
| --- | --- |
| `subagent` fork | 在派发时复制父会话快照和意图；后续父会话输入不会自动同步。通过 `task_id` 显式发送补充任务。 |
| `subagent` clean | 独立岗位指令、工具范围、生成设置、可信 Hook 引用、只读 guard，以及按员工身份隔离的长期记忆。可临时配置，也可通过 `agent_id` 复用注册定义。 |
| `team` | 保存流程、校验依赖、按并行数调度已有员工、记录结果、停止与显式恢复。节点执行仍调用同一个 subagent dispatcher，没有第二套模型循环。 |

员工注册和团队定义只在当前 Runtime 主机生效。员工可以使用主机已配置的模型；省略模型设置时新任务继承调用方当前默认模型。权限与可用工具始终受调用方和主机约束。

## 员工与记忆

`list_subagent_options({})` 默认只返回员工概要、插件角色及远端 Agent，不重复输出完整工具清单或配置。员工与工具列表支持 `query` 搜索及 `next_offset` 分页。读取员工完整定义时提供 `agent_id`，插件角色使用 `agent_type`；确需检查模型、默认设置及可信 Hook 时使用 `section: "settings"`，检查工具范围使用 `section: "tools"`。参见[工具按需返回](PROGRESSIVE_TOOL_DISCOVERY.md)。

```json
{"action":"save","expected_revision":0,"agent":{"id":"warehouse","name":"库存员","description":"核对库存与出库条件","system_prompt":"仅依据库存记录回答；缺少依据时说明缺口。","memory":"user","guards":["read_only"]}}
```

以上是 `subagent` 的注册参数。创建使用 `expected_revision: 0`；修改和删除必须带当前 revision，防止覆盖其他编辑者的修改。

```json
{"agent_id":"warehouse","prompt":"核对 SKU-42 的可用库存。"}
```

每次新任务创建独立会话；`task_id` 续接原任务的历史。运行时复用现有 SessionStore、会话日志、上下文压缩和恢复机制。岗位定义在任务首次派发时冻结；更新注册定义影响新任务，不会悄悄改写旧会话的角色。

长期记忆复用已有 Agent memory 存储与 `agent_memory_read` / `agent_memory_write`：

- `user`：当前主机上此员工的独立记忆，不是主用户习惯库。
- `project` / `local`：沿用现有项目记忆范围。
- `none`：关闭长期记忆。

新会话载入有界记忆摘要，完整内容按需读取；写入仍受 revision 冲突检查。跨任务共享的是该员工的记忆，不会把所有任务对话拼接到一起。注册员工关闭主用户习惯和预测引用。只读员工也不能写记忆。

Hooks 只引用已安装且已受信任的 Hook ID；注册不能写任意可执行脚本或授予信任。主机全局 Hooks 仍然执行。当前内置 guard 为 `read_only`，在工具执行前拒绝修改类调用。禁用或删除注册后不能再启动或恢复该员工；删除注册不会删除历史会话或记忆。

## Team 工具

支持 `list`、`get`、`save`、`delete`、`run`、`status`、`wait`、`stop`、`resume`。`list` 默认只列流程概要；`section: "runs"` 按需列当前会话的运行摘要。`get` 读取完整定义；`save` 返回 ID、revision 等简短回执。

```json
{"action":"save","expected_revision":0,"definition":{"id":"order-check","name":"订单核验","max_parallel":2,"nodes":[{"id":"stock","agent_id":"warehouse","prompt":"核对订单中的库存"},{"id":"review","agent_id":"reviewer","prompt":"根据库存结果检查出库条件","depends_on":["stock"]}]}}
```

每个节点引用已注册、已启用的员工。无依赖的节点可以并行；有依赖的节点等待前序完成，只收到直接前序结果和本次任务输入。自引用、缺失依赖、重复节点和循环依赖在保存时拒绝。

```json
{"action":"run","team_id":"order-check","input":"检查订单 42，说明是否满足出库条件。"}
```

运行返回 `run_id`。团队拥有独立的取消信号，父轮结束或等待取消不会中止团队。`status` 只返回进度；需要结果时直接用 `wait`，无需先轮询 `status`，已完成的运行会立即返回；想停止团队时用 `stop`。

`wait` 默认只返回最终节点（没有后续依赖者的节点）的完整输出，同时保留所有节点的状态、任务身份和 `has_output`。有多个最终分支时全部返回。`result_node_ids` 标明最终节点；追溯中间证据使用 `{"action":"wait","run_id":"…","node_ids":["stock"]}`，指定节点的输出不截断。完整运行结果继续保存在存储及管理界面中。

主会话仍在运行时收到完成通知；文本 assistant 也能在后台完成后继续回复。通知只携带最终节点产出及各节点状态，不附带中间长文，也不需要模型再调用一次工具才能拿到最终成果。如果同一版本的最终结果已经由 `wait` 读取，通知不会再次进入模型上下文或引发 assistant 额外回复；仅查看中间证据不会吞掉最终交付。恢复运行产生新结果版本，仍会正常通知。普通主会话已经结束时，结果可在后续轮通过 `wait` 读取。

`completed` 只表示节点执行结束，不代表内容经过独立核验。流程作者应在节点任务里说明交付物和验收条件；员工依据任务和上游证据工作，汇总时核对结论、指出缺失依据。主 Agent 交付有效成果，并区分已验证事实与员工建议；耗时原因需要实际证据，不能仅根据运行时间推断模型负载。

失败时停止派发后续节点，已运行的同级节点会完成。`resume` 保留成功节点，对失败且已建立会话的节点续接原历史。运行时重启后，未完成运行标记为 `interrupted`，必须明确恢复；不会自动重放可能产生副作用的操作。团队定义及员工定义按运行冻结，恢复不会换成后来编辑的流程。

## 存储和入口

管理入口位于应用中心的 **Team**，不再放在 Beta 菜单。团队流程与内置 **md演示** 共用图谱渲染和 Markdown 编辑器，支持拖动节点、编辑依赖链接、导入/导出 `.md` 文件。聊天右侧详情使用同一图谱只读查看。格式和操作见 [md演示](MD_PRESENTATION.md)。

- `<runtime data root>/registered-agents`：带 revision 的员工定义。
- `<runtime data root>/teams/definitions`：团队流程。
- `<runtime data root>/teams/runs`：节点状态、执行快照、结果和错误。
- 现有 Agent memory 和会话目录继续负责记忆与上下文持久化。

管理界面通过 `runtime.agent_registry` 和 `runtime.team_workflow` 使用同一组存储。启动与恢复由有模型和权限上下文的 Agent 轮执行；界面负责编辑、查看和停止。旧 `team` 插件不再加载；其配置不自动兼容或迁移。

对话预览与工作摘要分别展示员工注册、Team 注册和实际执行。注册回执可点击查看当前定义，Team 成员可继续打开员工详情；员工使用岗位名称和工牌图标。历史摘要只保留操作类型、身份和任务 ID，不附带岗位指令等完整配置；点击详情才通过当前主机的 `get` 命令读取，配置默认折叠。注册和删除不会发布子任务派发事件。

`/team` 选择器支持搜索、上下方向键、Home/End、Enter/Tab 确认和 Escape 取消。选中的 Team 是草稿内的显式引用，发送和重新打开历史后仍可点击，在右侧查看 Team 注册流程及成员详情。选择只保存身份，不执行团队任务，也不把完整配置附加到输入中。工作区默认 Team 在发送时写入本条消息；草稿中的显式选择优先，后续切换默认团队不会改变已提交的消息。

## 验证

`npm run test:team` 覆盖注册与冲突、fork/clean 隔离、跨任务记忆、只读约束、DAG 串并行、父轮退出、停止恢复、重启中断、真实 Runtime 会话、文本 assistant 调度及管理界面。

# 后台 MCP 等待与子代理续接

这是 CardBush 宿主能力。插件仍提供普通 MCP 工具，不需要识别 CardBush 会话、主子关系或实现反向唤醒协议。

## 后台工具调用

先用 `mcp_search` 加载目标工具完整 schema，再调用 `start_mcp_tool`，传入 `name`、原始 `arguments` 和有界 `max_wait_ms`。可选 `repeat_while`：

```json
{ "path": ["structuredContent", "status"], "equals": "timeout" }
```

条件必须来自目标工具声明的结果结构。宿主只在指定路径精确匹配时续调，不重新请求模型、不自动重试错误、不修改工具参数。默认预算五分钟，最多一小时。只接受声明 `readOnlyHint=true` 的 MCP 工具；这个标记不授予执行权限，每次调用仍经过发现检查、当前定义检查、子代理约束、审批、Hook 和工具原有超时。定义变更后停止续调。

启动立即返回 `task_id`，模型可以继续其他工具。`manage_tool_calls` 支持 `list`、`wait`、`cancel`，可选 `task_ids` 和 `mode=any|all`。结果通过内部 `background_tool_result` 在下一模型边界交付一次，保持外部工具数据的信任级别；执行记录保留各次调用的结果。取消单个等待不影响其他任务，停止当前 Turn 会取消该 Turn 的后台调用。

当模型没有其他工作、试图结束 Turn，而后台工具或子代理仍未完成时，宿主挂起等待首个结果，随后继续模型。这仅延续已经活动的 Turn；不会启动新对话、注册自动化，也不会在程序重启后重放后台操作。

## 子代理续接

```json
{ "prompt": "继续处理后续问题", "resume_task_id": "先前返回的 taskId" }
```

以上参数传给 `subagent`。每次续接生成新的任务与 Turn，保持原 child session；子代理自己的历史、原始前缀、模型和设置保留。工具与权限取原配置和当前宿主限制的交集，同一 child session 不允许并发续接。只允许原父会话续接自己拥有的普通子代理，Team 任务仍由 Team 管理。父会话工作区已经变化时拒绝隐式移动旧子代理。

原始执行配置写入运行数据目录 `subagent-context`，配合既有会话持久化可在重启后续接。只对保存了这份配置的任务生效；旧版本已结束且缺少配置的子代理会明确报错，不猜测其权限或原始上下文。新任务应保存返回的 taskId；聊天室等插件的成员凭证仍由各代理自己的上下文持有。

`await_subagents` 新增 `mode=any|all`，默认 any，允许依赖单个先完成的结果继续工作；未完成的兄弟任务继续运行。显式选择已经完成的任务可再次获取结果。

## 验证

`backgroundToolCalls.test.mjs` 验证独立工作、无模型轮询续等、取消、跨 Turn 隔离、权限与 Hook；`subagentResume.test.mjs` 验证宿主重建后的上下文保留、原模型、所有权、并发续接限制和 any 等待。

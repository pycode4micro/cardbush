# 会话事件、提醒与订阅

在当前会话请 Agent 注册跟进。例：「每周一上午九点（上海时间），在这个项目里检查构建结果。」Agent 使用 `assistant_event`，成功回执中的 `eventId` 与 `nextAt` 可用于核对、修改和取消。

- `create` 注册一次性任务，`at` 使用含时区的 ISO 时间。普通会话的 `text` 要写明执行目标、输入和交付要求。到期后独立执行，沿用登记时的项目、模型、工具和权限。
- `subscribe` 注册周期事件。传入稳定的 `topic`、任务 `text` 和 `recurrence`，例如 `{"unit":"week","interval":1,"startLocal":"2026-11-09T09:00","timeZone":"Asia/Shanghai","weekdays":[1]}`。普通会话也可以用 `session_hook` 订阅该会话的 Stop、PostToolUse 或 PostToolUseFailure。Assistant 的主动跟进和桥回复继续遵守其事件偏好和来源路由。
- 用 `list`、`read` 查看当前会话的事件。修改时间或任务说明时用 `continue` 和原 `eventId`。暂停用 `pause`，恢复用 `resume`，明确取消后用 `delete`。
- 桌面端「主页 → 事件」可以查看事件和执行记录。「个人资料 → 主动事件」可以管理事件。在执行记录中展开某一次，可以直接阅读那次保存的结果。已有计划和已读状态沿用原记录。保存和成功执行是两个不同的状态。

CardBush 的 Runtime 运行时负责检测到期时间、执行权限检查和插件唤醒。旧工具 `schedule_task` 可管理已有计划，`scheduled_results` 可读取执行结果。

普通会话注册的独立执行事件结束后，桌面会提示结果，来源会话底部也会显示未读摘要。点击通知会定位到来源会话中的提醒卡；点击对勾确认已读。

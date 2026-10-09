# 工具按需返回

发现能力时只返回可用对象的标识、简短用途和必要状态。已注册员工、团队与定时任务直接使用保存的配置；只有检查或修改配置时才读取详情。保存成功返回 ID、revision 等回执，不重复回显刚提交的长指令。

| 入口 | 默认发现或状态 | 按需展开 |
| --- | --- | --- |
| `list_subagent_options` | 注册员工、插件角色、远端 Agent 的能力摘要 | `agent_id` 读员工完整定义；`agent_type` 读插件角色；`section: "settings"` 读模型、默认值和可信 Hook；`section: "tools"` 检索工具范围 |
| `list_plugin_commands` | 命令用途、参数提示和调用资格 | `command` 读一个命令的完整描述与参数提示；`run_plugin_command` 执行 |
| `team` | `list` 返回流程摘要；`status` 返回运行进度，不附岗位指令、流程配置或节点输出 | `get` 读流程配置；`list` + `section: "runs"` 看当前会话运行摘要；`wait` 读运行结果，已完成的任务立即返回 |
| `manage_plugin_agents` | `list` 返回当前会话的后台任务状态和是否已有结果 | `read` + `task_ids` 读取所选结果；`wait` 等待并读取结果 |
| `schedule_task` | `list` 返回任务名、触发时间、状态和最近一次运行状态 | `get` + `job_id` 读可编辑配置；结果由 `scheduled_results` 读取 |
| `scheduled_results` | 返回执行结果的简短摘要 | `run_ids` 读取所选记录保存的完整结果 |

上述目录查询支持 `query`、`offset`、`limit`，默认最多 20 条、最多可请求 50 条，同时限制页面文本量约 6,000 字符。描述有单条预览上限，但搜索使用完整描述。继续查询应保持原查询条件，将 `next_offset` 传为 `offset`；`next_offset: null` 表示结束。`list_subagent_options` 的分页只用于员工或工具列表，不用于单对象详情和设置。`scheduled_results` 不搜索，固定每页最多 20 条，同样使用 `next_offset` 翻页。

MCP 的 `mcp_search` 已区分简要搜索与 `action: "load"` 加载工具 schema；Skill 搜索已返回简介和文件引用，正文按需读取。执行历史也使用摘要和归档定位符。这些入口继续沿用原有机制。

这些规则只改变模型的发现与管理回执。原生配置界面、持久化定义、权限检查及执行链路继续使用完整数据。显式读取的长详情和任务结果仍可通过 Runtime 原有工具结果归档读取，不因目录精简而丢弃。

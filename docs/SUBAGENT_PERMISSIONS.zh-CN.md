# 子 Agent 基线配置

[English](SUBAGENT_PERMISSIONS.md) · [简体中文](SUBAGENT_PERMISSIONS.zh-CN.md)

每个新根 Turn 冻结一份明确的子 Agent 基线，普通 fork 与 Team 成员共用。Team／Profile 可以收紧工具并增加角色、Skill、Hook、guard，但不能悄悄放宽已冻结基线。

高级本地配置不提供通用 GUI 表单，路径：`<Electron userData>/product-host/config/subagents.json`。默认值：

```json
{
  "protocol": "cardbush.subagent_configuration.v1",
  "permissionRouting": "user",
  "childPermissionMode": "task_free",
  "model": { "mode": "inherit" },
  "disabledTools": [
    "subagent",
    "team_delegate",
    "request_user_input_async",
    "update_goal",
    "schedule_task"
  ]
}
```

未知字段拒绝；旧权限文件迁入版本化结构。修改仅影响后续根 Turn，活动 Turn 及其全部子任务保持不可变快照。

## 权限路由

- `user`（统一）默认继承父 Turn 的用户权限模式与能力范围。
- `parent`（模型批准）保留父模式，子任务使用 `childPermissionMode` 和独立会话范围；权限事件仍通过活动父 Turn 传递。

根 Turn 完全访问时，`all_free` 是执行树的继承默认值，与路由无关。普通询问在 Runtime 内解决，不传到 GUI；硬准入拒绝不可绕过。显式 clean 可降低权限，修改路由不能抬高原权限上限。

输入框路由是每轮产品选择，优先于文件 `permissionRouting` 和 clean／员工角色默认配置，续接子会话也使用当前选择。父审批请求保留审计事件，但不进入人工审批队列。远程任务同步携带该选择；远端管理员明确禁止模型审批时，显示原因并上交人工。不支持此能力的旧 worker 需先升级才能使用模型审批。`childPermissionMode` 接受 `task_free`、`user_free`、`all_free`；提高权限仅可通过配置，搭配 parent 路由会产生启动安全提示。

## 模型策略

`{"mode":"inherit"}` 继承父模型；固定已配置模型只存稳定 ID：

```json
{"mode":"fixed","modelId":"reviewer-model"}
```

Product Host 在根 Turn 创建时解析 ID，传入不透明 Provider binding。密钥和端点不复制进子代理配置／Turn 元数据。

## 工具限制

`disabledTools` 复制到子 Turn 元数据，是执行准入拒绝列表，不再删除声明。继承型子代理保留父工具顺序；显式 Profile allowlist 仍可收紧目录。受限调用在 Hook、审批和执行之前返回 `child_agent_tool_unavailable`，Profile 无法重新启用基线禁用工具。

`agentRole=child` 时，即使 deny list 为空或完全访问，也禁止 `subagent` 再派发；内部 `team_delegate` guard 同样生效，返回 `child_agent_dispatch_unavailable`，要求完成分工并向父任务报告依赖。插件 Skill／Command 的 `context: fork` 也受限制；普通 inline Skill 沿既有策略可用。原生 `team` 由同一 dispatcher 与权限边界执行，子 Agent 不可调用。旧 Team 插件不再加载，见[原生 Team](TEAM_NATIVE_WORKFLOWS.md)。

## Fork 与 clean

`subagent.mode` 默认 fork，普通委派（包括自包含任务）使用它。仅在用户明确需要独立配置时选 clean，避免普通并行工作先花一轮构造配置。

Fork 复制派发前的完整消息（包括 system/developer），再追加明确角色和以 `你当前处于子agent状态` 开头的用户任务。它不重写父历史、工具或顺序。`system_prompt`、`allowed_tools`、`settings` 仅供 clean，fork 携带时拒绝。

`list_subagent_options` 默认返回可复用员工和已安装角色，支持搜索／分页。注册员工已有配置；按需用 `agent_id` 或 `agent_type` 读取单项。`section: "settings"` 返回模型 ID、限额、Skill 范围、权限上限、可信 Hook；`section: "tools"` 搜索子工具，均不返回模型凭据。Skill 在已声明范围内通过 `search_skills` 发现。

临时 clean 的必填 `system_prompt` 是实际系统消息，`prompt` 是带子状态提醒的用户任务；不复制父历史或系统提示。父方必须提供必要事实、用户交流语言、行为与交付要求。`agent_type` 还施加插件角色指令、限制及环境。

Clean settings 提供 `model_id`、`reasoning_effort`、`max_context_tokens`、`max_output_tokens`、`temperature`、`top_p`、`max_turns`、`permission_mode`、`permission_routing`、`disabled_tools`、`allowed_skills`、`disabled_skills`。单独的 `allowed_tools` 是精确白名单：省略保留父目录，空数组不允许任何工具。插件不能补回排除的 MCP，执行时也检查相同白名单。宿主支持时才暴露 `agent_type`／`run_in_background`。未指定项使用已展示默认值；Token 不超所选配置、执行限额尊重角色、显式范围与宿主求交集。内部身份及递归派发限制不由父方配置。

用户请求独立配置后的示例：

```json
{
  "mode": "clean",
  "system_prompt": "审查给定代码，使用中文报告进度和问题。",
  "prompt": "检查给定改动的正确性。我会同时实现界面；请返回可处理的问题和文件位置。",
  "allowed_tools": ["read_file"],
  "settings": { "reasoning_effort": "high", "max_turns": 12, "permission_mode": "task_free" }
}
```

当前合同只用 `mode`，不接受旧 `inherit_context`。续接只传 `task_id`、`prompt` 和可选 `run_in_background`，不覆盖名称、模式或配置；原身份与执行范围保留。

分工应说明子任务、父方并行工作、待满足依赖及交接方式，不能把未来输入当成已确认事实。相同模型参数、工具和前缀有利于服务商缓存复用，但换模型、收紧角色工具、省略历史及服务端行为都可能影响命中，不能保证。

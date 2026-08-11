# CardBush 前后端能力对照与待实现清单

更新时间：2026-08-11

适用仓库：

- 前端：`cardbush-electron`
- 后端：`bushserver`

## 1. 总体边界

这份文档只记录 CardBush 前端真实需要 BushServer 提供的 Agent、会话和运行态契约。

边界原则：

1. 前端以 `GET /v1/capabilities` 为唯一能力发现来源，不用 404、Provider 名称或版本号猜功能。
2. 后端负责 Agent loop、上下文、权限、工具、工作流和持久化；Electron 负责窗口、文件选择、桌面 UI 和本机系统集成。
3. SSE 事件必须是结构化状态，不要求前端解析 assistant 正文或工具输出文本来推断运行态。
4. 所有 session、turn、message、interaction、change 和 workflow run 标识必须稳定，刷新后仍可定位。
5. 新能力必须默认关闭或由 capability gate 控制，旧后端应继续可用。

## 2. 实现优先级总表

| 优先级 | 能力 | 后端状态 | 前端状态 | 说明 |
| --- | --- | --- | --- | --- |
| P0 | Shadow 临时只读会话 | 已实现 | 已接接口和独立 UI | 用户显式创建，按工具副作用声明强制只读 |
| P0 | 当前上下文窗口占用 | 已实现 | 已接 REST、SSE 和等待态 | 来自 Runtime 有效上下文预算，不是累计账单 |
| P0 | 工作区文件变更流 | 已实现 | 已接 SSE、REST 恢复，保留 tool metadata 回退 | manifest 声明的路径变更实时聚合并按 turn 持久化 |
| P0 | Turn 完成时间持久化 | 已实现 | 已接入 | 完成、停止和错误均使用服务端时间 |
| P1 | 会话标题与活动排序稳定性 | 标题已实现，活动排序待持续验证 | 已做 optimistic 标题和合并保护 | `title_source` 已区分 default、first_user_message、manual |
| P1 | 错误 envelope 统一 | 待硬化 | 已兼容 FastAPI 多种 `detail` | 便于 UI 精确处理错误 |
| 已有 | Reasoning 独立流 | 已实现 | 已接入 | 不混入 assistant 正文或历史 |
| 已有 | 权限请求 | 已实现 | 已接入 | 模型驱动，覆盖输入区处理 |
| 已有 | 快速上下文检索 | 已实现 | 已接入并有本地懒加载回退 | 不需要一次加载全历史 |
| 已有 | Team YAML Workflow | 已实现基础契约 | 已接入 | 详见 Team 专项清单 |
| 已有 | MCP 配置 | 已实现/联调中 | 已接入 | 远程工具和 Agent 均走 MCP |
| 已有 | 编辑消息并重跑 | 已实现 | 已接入 | 依赖稳定 message ID |

## 3. Capabilities

后端至少应返回以下能力位。snake_case 为规范字段，camelCase 可作为兼容别名：

```json
{
  "features": {
    "reasoning_stream": true,
    "permission_requests": true,
    "session_context_search": true,
    "message_window": true,
    "team_workflows": true,
    "workflow_runtime": true,
    "shadow_conversation_activation": true,
    "context_window_usage": true,
    "workspace_changes": true,
    "session_activity_ordering": true,
    "turn_regenerate": true,
    "stable_message_ids": true,
    "mcp_servers": true,
    "model_configs": true
  }
}
```

建议为关键能力同时返回说明对象：

```json
{
  "context_window_usage": {
    "available": true,
    "endpoint": "/v1/sessions/{session_id}/context-window",
    "event": "context_window_usage"
  },
  "workspace_changes": {
    "available": true,
    "events": ["workspace_change"],
    "persistence": "per_turn"
  },
  "shadow_conversation_activation": {
    "available": true,
    "mode": "shared_context_read_only"
  }
}
```

能力为 false 时，前端不会调用对应新接口，并保留现有降级逻辑。

## 4. P0：Shadow 临时只读会话

### 4.1 产品语义

Shadow 是用户主动打开的临时聊天，不进入主消息流。它共享创建时的主会话上下文快照，但自身只能读取，不能写文件、执行副作用工具、申请权限或改变主 loop。

前端已经实现：

- Composer 左下角 Shadow 图标显式激活。
- Shadow 展开后接管同一个输入区，使用独立草稿和青色边框。
- Shadow 收起后恢复主会话输入、草稿和发送行为。
- Shadow 消息不进入主消息列表，不更新 session 标题。

### 4.2 接口

```text
POST /v1/sessions/{session_id}/shadow-conversations
POST /v1/shadow-conversations/{shadow_conversation_id}/messages/stream
POST /v1/shadow-conversations/{shadow_conversation_id}/close
```

创建请求：

```json
{
  "source_turn_id": "turn_optional",
  "mode": "shared_context_read_only",
  "client_conversation_id": "uuid"
}
```

创建响应：

```json
{
  "shadow_conversation_id": "shadow_...",
  "session_id": "session_...",
  "source_turn_id": "turn_...",
  "agent_name": "Shadow Agent",
  "status": "active",
  "created_at": "2026-08-07T08:31:42.412Z"
}
```

消息请求：

```json
{
  "content": "检查这个方案是否遗漏边界条件",
  "client_message_id": "uuid",
  "model": "glm-5.2",
  "provider": "openai-compatible",
  "api_key": "...",
  "base_url": "https://provider.example/v1",
  "reasoning_level": "medium"
}
```

SSE：

```text
shadow_start  {shadow_conversation_id,message_id,created_at}
shadow_token  {shadow_conversation_id,message_id,delta}
shadow_done   {shadow_conversation_id,message_id,content,completed_at}
shadow_error  {shadow_conversation_id,message_id,code,message}
```

### 4.3 后端约束

- 创建时冻结有效上下文快照，主 loop 后续消息不能悄悄改变该 Shadow 的语义基线。
- 后端通过不给 Shadow LLM 请求装配任何工具 schema 强制只读，prompt 只用于正向解释边界。
- Shadow 不得触发 `request_permission`。
- Shadow 消息与错误独立审计，不出现在普通 `GET /v1/sessions/{id}` messages 中。
- 同一 session 第一版只允许一个 active Shadow；重复创建应幂等返回当前 active 会话。
- 关闭 Shadow 不能 stop 主 turn，主 turn 完成也不能删除已打开的 Shadow 内容。

### 4.4 验收

- 主 turn 运行中可以创建和使用 Shadow。
- Shadow 无法调用写工具或权限工具。
- 关闭后主输入草稿完整恢复。
- 刷新主历史不会混入 Shadow 消息。

## 5. P0：当前上下文窗口占用

### 5.1 接口与事件

```text
GET /v1/sessions/{session_id}/context-window
event: context_window_usage
```

统一 payload：

```json
{
  "session_id": "session_...",
  "turn_id": "turn_...",
  "model": "glm-5.2",
  "used_tokens": 38420,
  "max_tokens": 128000,
  "remaining_tokens": 89580,
  "usage_ratio": 0.3001,
  "measured_at": "2026-08-07T08:31:42.412Z",
  "source": "runtime_context"
}
```

### 5.2 字段语义

- `used_tokens`：压缩、裁剪、summary 和工具 follow-up 处理后的当前有效上下文。
- `max_tokens`：当前模型与 Provider 路径真正可用的窗口上限，优先于前端模型配置。
- `remaining_tokens`：有效剩余空间，不是账户余额。
- `usage_ratio`：0 到 1；后端不返回时前端可以用 used/max 计算。
- `measured_at`：本次测量时间。
- `source`：建议固定为 `runtime_context`，不要伪装成计费 usage。

建议在以下时机发事件：

1. `start` 后上下文装配完成。
2. 自动压缩或 summary 完成。
3. 大型工具 follow-up 注入完成。
4. 切换模型、编辑重跑或 regenerate。
5. `done` 前最终测量。

不需要逐 token 推送。

### 5.3 验收

- 刷新会话能通过 GET 恢复最新值。
- SSE 更新后 Composer 无需刷新立即变化。
- 切换模型后 `max_tokens` 随实际运行路径更新。
- 累计 usage 很高但当前上下文被压缩时，`used_tokens` 必须下降。

## 6. P0：工作区文件变更流

### 6.1 目标

前端已有“更改中”运行条和审查入口。后端从工具 manifest 的 `mutates_path` 声明和 ResourceManager 的可信规范化路径生成统一的 turn-scoped 结构化变更事件，不按工具名或语言猜测。

事件名：

```text
workspace_change
```

前端也兼容 `file_change`，新后端建议统一使用 `workspace_change`。

### 6.2 Payload

```json
{
  "change_id": "chg_01J...",
  "session_id": "session_...",
  "turn_id": "turn_...",
  "revision": 3,
  "status": "running",
  "files": [
    {
      "path": "src/App.tsx",
      "status": "modified",
      "additions": 18,
      "deletions": 2,
      "diff": "optional unified diff"
    }
  ],
  "additions": 18,
  "deletions": 2,
  "summary": "1 file changed",
  "created_at": "2026-08-07T08:31:42.412Z"
}
```

`status`：

```text
running | completed | failed | cancelled
```

### 6.3 聚合规则

- 同一 turn 使用稳定 `change_id`。
- `revision` 单调递增。
- 每个事件返回当前累计快照，不返回无法区分的局部增量。
- `files/additions/deletions` 必须互相一致，避免前端重复累计；无法从通用运行时证明行数时返回 0，不猜测 diff。
- 路径相对当前 workspace；工作区外路径必须返回绝对规范路径并经过权限审计。
- `diff` 可选，缺失时审查页可由 Electron 本地 Git/文件能力获取。
- 事件不得包含密钥、环境变量值或完整命令输出。

### 6.4 持久化

刷新后至少要能从以下任一位置恢复最终摘要：

- turn/message metadata 中的 `workspace_changes`；或
- `GET /v1/sessions/{session_id}/workspace-changes?turn_id=...`。

推荐查询响应：

```json
{
  "session_id": "session_...",
  "items": [
    {
      "change_id": "chg_...",
      "turn_id": "turn_...",
      "revision": 5,
      "status": "completed",
      "files": [],
      "additions": 99,
      "deletions": 27,
      "completed_at": "..."
    }
  ]
}
```

### 6.5 验收

- 连续修改同一文件不会把累计行数重复相加。
- 新增、修改、删除、重命名均有明确 status。
- edit/regenerate 后旧链路变更仍可审计，但不会合并进新 turn 的实时条。
- `completed` 后前端保留最终文件数和行数。

## 7. P0：Turn 完成时间

历史消息必须暴露可持久化的时间字段：

```json
{
  "turn_id": "turn_...",
  "started_at": "2026-08-07T08:20:00.000Z",
  "completed_at": "2026-08-07T08:31:42.412Z",
  "duration_ms": 702412
}
```

规则：

- `completed_at` 由服务端产生，刷新后不变。
- stopped/error turn 也要记录终止时间，并通过状态区分。
- 前端实时阶段可暂用接收 `done/error` 的本机时间，历史刷新后必须以服务端值覆盖。
- 不要把消息入库时间当作完成时间。

## 8. P1：会话标题与最近活动

### 8.1 标题

- 新 session 默认标题是 `新会话`，不能显示 raw session ID。
- 第一条 user 消息持久化后，标题应更新为该消息的清理后摘要。
- 后续 turn、刷新、session list 重载不能把标题改回 `新会话` 或 session ID。
- 建议返回 `title_source = first_user_message | user_override | default`。
- 用户手动重命名后，自动标题逻辑不得再次覆盖。

### 8.2 最近活动

`GET /v1/sessions` 建议返回：

```json
{
  "sessions": [
    {
      "session_id": "session_...",
      "title": "...",
      "updated_at": "...",
      "last_activity_at": "...",
      "source": "cardbush | weixin | other"
    }
  ],
  "next_cursor": null
}
```

后端按 `last_activity_at DESC` 排序，至少保证最近会话不会因默认 limit 被旧数据挤掉。

## 9. P1：统一错误格式

推荐逐步统一：

```json
{
  "detail": {
    "code": "active_turn_exists",
    "message": "A turn is already running for this session.",
    "details": {},
    "request_id": "req_..."
  }
}
```

前端仍兼容 `detail` 字符串、对象和 FastAPI 422 数组，但新增接口不要继续引入新的错误形状。

常用 code：

```text
active_turn_exists
interaction_expired
permission_denied
shadow_conversation_closed
workflow_validation_failed
context_window_unavailable
```

## 10. 已实现能力，不得回归

### Chat 与历史

- `POST /v1/chat/stream`
- `GET /v1/sessions`
- `GET /v1/sessions/{session_id}`
- stable `message_id/id`、`turn_id`、`turn_sequence`、`message_index`
- message edit and regenerate
- turn stop
- optimistic user message 在 `done` 后不能消失

### Reasoning

- 顶层请求字段 `reasoning_trace_visible`
- 独立 `reasoning` SSE
- 不进入 assistant 正文和普通历史

### 权限与交互

- 正式聊天请求通过 `requestCapabilities.interactiveRequests=true` 显式装配 `request_permission` 和 `request_user_choice`；未声明时后端不暴露这两个工具。
- SSE `path_permission_request`。
- 回复选项 `allow_once | allow_session | deny`。
- 后端按真实子会话绑定权限，前端只回 `interaction_id`。

### 快速上下文

- `POST /v1/sessions/{session_id}/context-search`
- `GET /v1/sessions/{session_id}/messages/{message_id}/window`
- 服务端返回稳定 message ID、snippet、score 和懒加载 cursor。

### 其他

- Skills / tools / MCP 管理。
- 模型配置与最大上下文窗口配置。
- 项目结构上下文。
- 浏览器隐私模式。
- 代理默认绕过 loopback。

## 11. 明确下线，不要继续实现

以下属于旧设计或已从前端删除：

- 旧的人类 Team、成员、Mission、节点聊天、组织权限模型。
- 旧 `/v1/team-flows/*` 对话式 Team Planner UI。
- 后端主动推送并占用主 UI 的 `shadow_message` 方案。
- 独立 Agent Visual Scene / HTML 展示窗。
- `local-agent`、`local-subagent` 注册、编辑、启停和删除接口。
- Game Coding、德州扑克和卡牌游戏 runtime。
- 本地音乐模块。

远程 Agent 统一通过 MCP 接入；本地子任务执行单元不由前端配置。

## 12. Electron 本地能力，不属于 BushServer

后端不需要实现：

- 文件路径链接的打开、打开方式、定位到目录和复制。
- Windows 应用枚举、图标提取、窗口切换、任务栏和壁纸。
- 项目目录是否仍存在、项目选择器和最近项目清理。
- 开机启动、加载页、窗口拖动、全屏和侧边栏布局。
- Git 本地分支 checkout 的 UI 与 Electron IPC。

如果 Agent 需要执行上述操作，BushServer 只负责工具调用、参数、权限和审计；实际系统动作由 Electron 本地能力完成。OS 专项见 `docs/ai-native-os-backend-checklist.md`。

## 13. 后端联调顺序

1. capability、context-window、workspace_change 和 Shadow 契约已经完成前后端对齐。
2. 继续硬化 session title、activity ordering 和错误 envelope。
3. 用真实长 turn 验证刷新、重连、stop、edit-regenerate 和多 session 隔离。
4. 只有真实数据证明需要时，再增加通用 diff 采集；不解析 shell 或语言语法猜测变更。

## 14. 最终验收

- 前端先启动、后端后启动，刷新后能恢复 capability、会话和运行态。
- 所有 SSE 事件都带稳定 `session_id/turn_id`，不会串会话。
- Reasoning、Shadow、Workflow、workspace change 不混入 assistant Markdown。
- 权限请求覆盖输入区，处理前不能发送普通消息。
- 文件变更条实时更新，刷新后仍能看到最终摘要。
- 上下文窗口显示真实有效占用，而不是计费用量。
- 新会话标题由第一条 user 消息稳定生成，不会在第二轮或刷新后丢失。
- 旧后端 capability=false 时前端可降级运行，不产生无意义 404。

# CardBush Team Workflow 后端对照清单

更新时间：2026-08-07

## 1. 模块定位

当前 Team 不是多人组织、成员聊天或 Team Agent 自动规划器，而是一个由用户显式设计的场景 Agent 工作流编排器。

核心流程：

1. 用户在 Team 页面创建一组节点。
2. 每个节点只描述该场景 Agent 的提示词、依赖与验收标准。
3. 前端导出 `cardbush.team_workflow.v1` YAML。
4. 后端负责校验、加载、按依赖调度、运行和持久化。
5. 普通对话通过 `/team <workflow_id> <task>` 显式启动工作流。

第一版不需要：

- Team 用户、Boss、员工或成员权限模型。
- 节点内独立的人类聊天窗口。
- LLM 自动创建或修改工作流。
- 旧 Team Flow 的逐层裁决 UI。
- 旧 `/v1/team-flows/*` 接口。

## 2. Capabilities

`GET /v1/capabilities` 至少返回：

```json
{
  "features": {
    "team_workflows": true,
    "teamWorkflows": true,
    "workflow_runs": true,
    "workflowRuns": true,
    "workflow_run_events": true,
    "workflowRunEvents": true
  },
  "team_workflows": {
    "available": true,
    "protocol": "cardbush.team_workflow.v1",
    "validate_endpoint": "/v1/team-workflows/validate",
    "launch_command": "/team",
    "runtime_events": [
      "workflow_started",
      "workflow_node_state",
      "workflow_node_output",
      "workflow_completed",
      "workflow_failed"
    ]
  }
}
```

前端只在 `team_workflows=true` 时调用服务端校验；否则仍允许本地编辑和导出 YAML。

## 3. YAML 协议

协议名固定为：

```text
cardbush.team_workflow.v1
```

标准示例：

```yaml
protocol: cardbush.team_workflow.v1
id: release-check
name: Release Check
version: 1
description: |-
  Inspect, verify, and summarize a project release.

nodes:
  - id: inspect
    title: Inspect project
    prompt: |-
      Inspect the project structure, build configuration, dependencies,
      and current changes.
    depends_on: []
    validation: |-
      List concrete risks and the evidence for each finding.

  - id: verify-ui
    title: Verify interface
    prompt: |-
      Open the built application and verify layout, interaction,
      and console output.
    depends_on: [inspect]
    validation: |-
      Report tested viewports and visible failures.

  - id: release-decision
    title: Release decision
    prompt: |-
      Summarize all upstream evidence and make a clear release decision.
    depends_on: [inspect, verify-ui]
    validation: |-
      Return a release or block decision with reasons.
```

### 3.1 顶层字段

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| `protocol` | 是 | 必须等于 `cardbush.team_workflow.v1` |
| `id` | 是 | 工作流稳定 ID，建议 `[a-z0-9_-]+` |
| `name` | 是 | 展示名称 |
| `version` | 是 | 正整数，保存结构变更时递增 |
| `description` | 否 | 工作流用途 |
| `nodes` | 是 | 至少一个节点 |

### 3.2 节点字段

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| `id` | 是 | 工作流内唯一稳定 ID |
| `title` | 是 | 场景 Agent 名称 |
| `prompt` | 是 | 该 Agent 的工作指令 |
| `depends_on` | 是 | 上游节点 ID 数组，可为空 |
| `validation` | 否 | 节点完成判定和证据要求 |

不要在 v1 中加入前端并未使用的 position、card style、human assignee、chat room 或 arbitrary executable 字段。

## 4. 工作流校验

### 4.1 接口

```http
POST /v1/team-workflows/validate
Content-Type: application/json
```

请求：

```json
{
  "yaml": "protocol: cardbush.team_workflow.v1\n...",
  "project_dir": "C:\\Users\\wfang\\Desktop\\cardbush-electron",
  "workflow_id": "release-check"
}
```

`project_dir` 和 `workflow_id` 可选。`yaml` 是当前前端必须支持的输入。

成功响应：

```json
{
  "valid": true,
  "errors": [],
  "warnings": [],
  "normalized": {
    "protocol": "cardbush.team_workflow.v1",
    "id": "release-check",
    "version": 1,
    "nodes": []
  }
}
```

失败响应仍建议返回 `200` 并用 `valid=false` 表达可修正的配置错误：

```json
{
  "valid": false,
  "errors": [
    {
      "code": "workflow_cycle_detected",
      "message": "Dependency cycle: inspect -> verify-ui -> inspect",
      "path": "nodes[1].depends_on",
      "node_id": "verify-ui"
    }
  ],
  "warnings": []
}
```

无法解析请求、认证失败和服务异常再使用 4xx/5xx。

### 4.2 必须校验

- protocol 是否支持。
- workflow ID 和 node ID 是否合法且唯一。
- 是否至少存在一个节点。
- prompt 是否为空。
- `depends_on` 指向的节点是否存在。
- 依赖图是否无环。
- 根节点和不可达节点是否合理。
- 节点总数、提示词长度和依赖数量是否超过后端限额。

Profile 不属于该协议的运行权威。后端按正常 Skills/Tools Runtime 为每个节点自主选择能力；旧 YAML 中的 profile 只产生弃用警告并被 normalize 移除。

## 5. 保存和加载

当前前端可把 YAML 保存为本地文件，后端至少需要约定扫描或安装位置，使 `/team <workflow_id>` 能稳定找到它。

推荐提供：

```text
GET    /v1/team-workflows
GET    /v1/team-workflows/{workflow_id}
PUT    /v1/team-workflows/{workflow_id}
DELETE /v1/team-workflows/{workflow_id}
```

如果第一版暂不提供 CRUD，后端必须明确：

- 工作流文件目录。
- 文件名到 workflow ID 的映射规则。
- 重名、版本冲突和热重载行为。
- 项目级与用户级工作流的查找优先级。

推荐 PUT 请求：

```json
{
  "yaml": "...",
  "expected_version": 3
}
```

版本冲突返回：

```json
{
  "detail": {
    "code": "workflow_version_conflict",
    "message": "Workflow changed after it was opened",
    "current_version": 4
  }
}
```

## 6. 启动工作流

第一版复用普通聊天入口：

```text
/team release-check 检查当前项目是否可以发布
```

前端仍调用：

```http
POST /v1/chat/stream
```

后端负责解析命令并：

1. 定位工作流。
2. 冻结本次运行使用的 workflow ID、version 和 YAML fingerprint。
3. 创建 `workflow_run_id`。
4. 将 chat session、turn 和 workflow run 绑定。
5. 按 DAG 依赖调度节点。
6. 将每个节点的上游结构化结果传给下游，而不是让前端拼 Prompt。

未知工作流返回结构化错误：

```json
{
  "detail": {
    "code": "unknown_team_workflow",
    "message": "Workflow release-check was not found",
    "workflow_id": "release-check"
  }
}
```

## 7. 调度语义

- `depends_on=[]` 的节点可进入 ready。
- 所有依赖成功后，节点才可进入 running。
- 没有依赖关系的节点允许并行。
- 默认并发上限由后端控制并在 capabilities 中声明。
- 上游失败时，下游默认标记 blocked，不得伪装成成功。
- validation 不为空时，节点完成前必须执行验收并保存证据摘要。
- stop 后不得再启动新节点；正在运行的节点应被取消或进入明确的 stopping 状态。
- 每个节点都使用正常 Skills/Tools Runtime；前端不参与工具、hooks 或事务策略执行。

节点状态建议固定为：

```text
pending | ready | running | validating | completed | failed | blocked | cancelled
```

运行状态建议固定为：

```text
queued | running | completed | failed | stopping | cancelled
```

## 8. SSE 事件

这些事件通过当前 `/v1/chat/stream` 返回，并与普通 `token/tool/reasoning/done/error` 共存。

### 8.1 workflow_started

```json
{
  "workflow_run_id": "wrun_123",
  "workflow_id": "release-check",
  "workflow_version": 3,
  "session_id": "local-...",
  "turn_id": "turn_...",
  "status": "running",
  "started_at": "2026-08-07T10:00:00Z",
  "node_count": 3
}
```

### 8.2 workflow_node_state

```json
{
  "workflow_run_id": "wrun_123",
  "node_id": "verify-ui",
  "title": "Verify interface",
  "status": "running",
  "started_at": "2026-08-07T10:01:00Z",
  "completed_at": null,
  "attempt": 1,
  "depends_on": ["inspect"]
}
```

### 8.3 workflow_node_output

```json
{
  "workflow_run_id": "wrun_123",
  "node_id": "inspect",
  "status": "completed",
  "summary": "Found two release blockers",
  "artifacts": [],
  "validation": {
    "passed": true,
    "summary": "Each finding includes evidence"
  },
  "completed_at": "2026-08-07T10:00:58Z"
}
```

不要在事件中泄露内部 chain-of-thought。`summary`、可见证据和产物引用足够。

### 8.4 workflow_completed

```json
{
  "workflow_run_id": "wrun_123",
  "workflow_id": "release-check",
  "status": "completed",
  "completed_at": "2026-08-07T10:04:00Z",
  "duration_ms": 240000,
  "completed_nodes": 3,
  "failed_nodes": 0
}
```

### 8.5 workflow_failed

```json
{
  "workflow_run_id": "wrun_123",
  "workflow_id": "release-check",
  "status": "failed",
  "failed_node_id": "verify-ui",
  "code": "workflow_node_failed",
  "message": "Browser validation failed",
  "completed_at": "2026-08-07T10:03:12Z"
}
```

所有事件必须携带稳定的 `workflow_run_id`。同一次运行重复事件应具有可幂等合并的状态，不要依赖到达次数计数。

## 9. 运行态 REST

前端当前已预留并调用：

```text
GET  /v1/workflow-runs/{run_id}
GET  /v1/sessions/{session_id}/workflow-runs?limit=20
POST /v1/workflow-runs/{run_id}/stop
```

### 9.1 GET run

```json
{
  "id": "wrun_123",
  "workflow_id": "release-check",
  "workflow_version": 3,
  "session_id": "local-...",
  "turn_id": "turn_...",
  "status": "running",
  "started_at": "2026-08-07T10:00:00Z",
  "completed_at": null,
  "nodes": []
}
```

### 9.2 GET session runs

```json
{
  "items": [],
  "next_cursor": null
}
```

`limit` 必须有上限；后续可增加 cursor，不能让前端一次读取无限历史。

### 9.3 POST stop

响应：

```json
{
  "id": "wrun_123",
  "status": "stopping",
  "stop_requested_at": "2026-08-07T10:02:00Z"
}
```

已完成运行重复 stop 应幂等返回当前状态，而不是 500。

## 10. 持久化和恢复

后端必须持久化：

- workflow ID、version、fingerprint。
- session ID、turn ID、run ID。
- 每个节点的状态、依赖、开始和结束时间。
- 节点可见摘要、验证结果、错误和 artifact 引用。
- stop/cancel 原因。

应用刷新或 SSE 重连后，前端应能通过 REST 恢复完整运行状态，不依赖内存事件重放。

不要仅保存当前 YAML 引用。运行必须绑定启动时的冻结版本，否则工作流编辑后历史会变义。

## 11. 安全边界

- 工作流只是编排声明，不自动扩大权限。
- 每个节点仍遵循 permission request、workspace root 和正常工具策略。
- 任一节点请求工作区外访问时继续使用 `request_permission`。
- 工作流 YAML 不允许携带明文 secrets。
- 不把任意 shell、Python 或 JavaScript 字符串当成工作流配置直接执行。
- 节点输出进入下游前由后端做尺寸限制和结构化压缩。

## 12. 明确废弃

后端不要为了当前 Team 页面继续实现或维护这些旧契约：

```text
GET  /v1/team-flows/{session_id}
GET  /v1/team-flows/{session_id}/graph
POST /v1/team-flows/{flow_id}/actions
```

也不需要以下旧事件：

```text
team_layer
team_node
team_action_required
```

前端 API 层目前可能暂存旧解析代码用于工作区兼容，但当前 Team 页面不消费它们，不能据此判断产品仍需要旧模型。

## 13. 推荐落地顺序

1. 固定 YAML schema 与 validate。
2. 固定工作流加载目录或实现 CRUD。
3. `/team` 创建 run 并发送 `workflow_started`。
4. 实现 DAG 状态机和 node state/output 事件。
5. 实现 run REST、停止和刷新恢复。
6. 最后补并行、重试、artifact 和更详细的验证证据。

## 14. 联调验收

- 前端本地 YAML 能通过后端 normalize 后保持语义不变。
- 重复 ID、缺失依赖、环、空 prompt 均返回可定位错误。
- 两个无依赖节点可并行，依赖节点只在上游成功后运行。
- SSE 中每个事件都有稳定 run ID 和 node ID。
- 刷新后 GET run 恢复与刷新前一致。
- stop 幂等，停止后不再启动新节点。
- 工作流编辑不改变已开始运行的冻结版本。
- 普通对话不启用 Team；只有显式 `/team` 才启动。
- 旧 Team Flow 接口不是第一版依赖。

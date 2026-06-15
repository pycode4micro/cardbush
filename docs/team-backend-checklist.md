# Team Runtime Backend Checklist

目标：支持前端 Team 模块从本地预览升级为真实组织任务运行态。第一版保持小而稳定：Team、Mission、DAG Node、Event、Node Chat、Artifact、Visibility。

## 1. Capabilities

`GET /v1/capabilities` 增加：

```json
{
  "features": {
    "team_runtime": true
  },
  "endpoints": {
    "team_runtime": {
      "available": true,
      "base_path": "/v1/teams"
    }
  }
}
```

## 2. Core Models

### Team

```json
{
  "id": "team_...",
  "name": "CardBush Team",
  "description": "...",
  "created_at": "...",
  "updated_at": "..."
}
```

### TeamMember

```json
{
  "id": "member_...",
  "team_id": "team_...",
  "display_name": "Aster",
  "title": "Boss / Mission Owner",
  "role": "boss | lead | member | ai",
  "permission": "owner | manager | contributor | observer",
  "assistant_profile": "boss_assistant",
  "scope": "mission_all | product_nodes | assigned_nodes | review_nodes",
  "skills": ["目标澄清", "DAG 拆分"],
  "metadata": {}
}
```

### Mission

```json
{
  "id": "mission_...",
  "team_id": "team_...",
  "title": "...",
  "objective": "...",
  "status": "draft | planning | running | review | done | cancelled",
  "created_by": "member_...",
  "created_at": "...",
  "updated_at": "..."
}
```

### TaskNode

```json
{
  "id": "node_...",
  "mission_id": "mission_...",
  "title": "...",
  "summary": "...",
  "owner_member_id": "member_...",
  "assistant_profile": "frontend_assistant",
  "status": "ready | running | blocked | review | done",
  "visibility": "boss | assignee | team",
  "depends_on": ["node_..."],
  "allowed_context": "...",
  "deliverable_contract": "...",
  "metadata": {}
}
```

### TeamEvent

```json
{
  "id": "event_...",
  "mission_id": "mission_...",
  "node_id": "node_...",
  "actor_member_id": "member_...",
  "type": "planned | assigned | started | blocked | submitted | reviewed",
  "visibility": "boss | assignee | team",
  "message": "...",
  "created_at": "...",
  "payload": {}
}
```

### Artifact

```json
{
  "id": "artifact_...",
  "mission_id": "mission_...",
  "node_id": "node_...",
  "author_member_id": "member_...",
  "kind": "brief | patch | checklist | file | link",
  "title": "...",
  "summary": "...",
  "content": "...",
  "visibility": "boss | assignee | team",
  "created_at": "..."
}
```

## 3. Minimal REST Endpoints

```http
GET    /v1/teams
POST   /v1/teams
GET    /v1/teams/{team_id}
PATCH  /v1/teams/{team_id}

GET    /v1/teams/{team_id}/members
POST   /v1/teams/{team_id}/members
PATCH  /v1/teams/{team_id}/members/{member_id}
DELETE /v1/teams/{team_id}/members/{member_id}

GET    /v1/teams/{team_id}/missions
POST   /v1/teams/{team_id}/missions
GET    /v1/missions/{mission_id}
PATCH  /v1/missions/{mission_id}

POST   /v1/missions/{mission_id}/decompose
GET    /v1/missions/{mission_id}/graph
PATCH  /v1/missions/{mission_id}/nodes/{node_id}

GET    /v1/missions/{mission_id}/events
GET    /v1/missions/{mission_id}/events/stream

GET    /v1/missions/{mission_id}/artifacts
POST   /v1/missions/{mission_id}/nodes/{node_id}/artifacts
POST   /v1/missions/{mission_id}/nodes/{node_id}/review
```

## 4. Node Chat Stream

每个节点有独立助理，不复用普通全局 chat session。

```http
POST /v1/missions/{mission_id}/nodes/{node_id}/chat/stream
```

Request:

```json
{
  "member_id": "member_...",
  "message": "当前节点内的问题",
  "attachments": [],
  "metadata": {
    "client": "cardbush-electron"
  }
}
```

SSE events 建议：

```text
start
token
tool
node_state
artifact_draft
event
error
done
```

后端必须按 `member_id + node_id` 裁剪上下文：

- Boss Assistant 可以看 mission 全局、全部节点状态、全部 team-visible/boss-visible artifact。
- Member Assistant 只看自己节点、公开上游依赖、自己节点历史、允许进入的 artifact。
- 普通成员不能收到其他成员的私有 node chat。

## 5. Visibility Rules

第一版只需要三种 visibility：

- `boss`: 只有 Boss / owner / manager 可见。
- `assignee`: Boss + 节点负责人可见。
- `team`: 团队公开可见。

后端返回数据时必须裁剪，不要只靠前端隐藏。

建议所有读取接口都支持：

```http
?viewer_member_id=member_...
```

或者从认证身份解析当前 member。

## 6. Decompose Contract

`POST /v1/missions/{mission_id}/decompose`

Request:

```json
{
  "objective": "...",
  "mode": "draft | apply",
  "constraints": {
    "max_nodes": 8,
    "prefer_existing_members": true
  }
}
```

Response:

```json
{
  "mission_id": "mission_...",
  "draft": {
    "nodes": [],
    "edges": [],
    "assignments": []
  },
  "events": []
}
```

`mode=draft` 只返回草案；`mode=apply` 持久化节点和分配。

## 7. Frontend Fallback

在后端未实现前：

- 前端显示本地 Team preview。
- `team_runtime=false` 时，所有写操作只在本地模拟。
- `team_runtime=true` 后，前端切换到真实接口。

## 8. First Milestone

建议后端第一轮只做：

1. capabilities 标记。
2. Team / Member / Mission CRUD。
3. `decompose` 返回可编辑 DAG 草案。
4. `graph` 按 viewer 裁剪返回节点。
5. `events` 和 `events/stream`。
6. node chat stream，先可以复用现有模型调用，但必须做 node scope 裁剪。
7. artifact submit / review。

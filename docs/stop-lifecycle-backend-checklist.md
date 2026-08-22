# Stop 生命周期后端对接清单

## 联合目标

Stop 只终止当前 turn，不删除已经发生的 UI 时间线；终态确认后，用户可以在同一 `session_id` 下创建新的 `turn_id` 继续工作。

前端已经按以下状态机实现：

```text
running
  -> POST /v1/turns/{turn_id}/stop
  -> stopping（保留 SSE 与全部本地轨迹）
  -> done 或终态查询确认
  -> stopped/completed（冻结轨迹，解除同 session 发送门禁）
```

前端不会再把 Stop HTTP 200 当成 turn 已终止，也不会在发起 Stop 时主动 abort SSE。

## P0-1：Stop 只返回受理状态

```http
POST /v1/turns/{turn_id}/stop
```

建议响应：

```json
{
  "turn_id": "turn_42",
  "accepted": true,
  "terminal": false,
  "already_inactive": false,
  "reason": "stop_requested"
}
```

要求：

- 接口幂等。
- `accepted=true` 仅表示停止请求已登记。
- 已终态时返回 `terminal=true`、`already_inactive=true`。
- 不要用 HTTP 200 暗示终态已持久化。
- 兼容期前端仍识别旧字段 `stopped=true` 为 `accepted=true`。

## P0-2：`done` 与查询返回同一份权威终态

SSE `done` 必须在 turn 终态、消息快照、工具状态和工作区变更完成持久化后发送：

```json
{
  "turn_id": "turn_42",
  "status": "stopped",
  "stopped": true,
  "stop_reason": "user_stop",
  "stop_scenario": "user_stop_cancelled",
  "stop_details": {
    "user_stop_requested": true,
    "cancelled": true,
    "partial": true
  },
  "completed_at": "2026-08-22T10:00:02.500Z",
  "duration_ms": 2500,
  "terminal_event_sequence": 123,
  "assistant_message": "已生成的部分文本"
}
```

要求：

- `done` 是该 turn 唯一权威终态事件。
- session/turn 查询返回相同的 `status`、停止字段、时间和 `terminal_event_sequence`。
- `done` 之后不得再产生属于该 turn 的 token、reasoning、tool、execution、workspace change 或 error。
- 正常完成与 Stop 竞态由后端原子裁决；前端以最终 `done.stopped` 为准。
- 不再在 `done` 后追加 `TurnStopped` error。

## P0-3：session 单活跃 turn 必须原子执行

要求在 turn 注册/事务层保证同一 session 只能存在一个非终态主 turn，不能只在 API 路由预检查：

- 旧 turn 未终态时，新普通 chat、regenerate、edit 均返回一致的 `409 active_turn_exists`，或进入后端显式等待队列。
- 新 turn 的 `snapshot_cutoff` 必须在旧 turn 终态提交后创建。
- 成功创建的新 turn 必须能读取刚停止 turn 已提交的 user、assistant 和可复用状态。

前端当前保持 `sending/stopping` 门禁，只有收到 `done` 或查询确认终态后才会发送同 session 的排队消息。

## P0-4：启动时恢复孤立主 turn

BushServer 启动时必须扫描孤立的 `submitted/running/stop_requested` 主 turn：

- 归档为 `stopped` 或 `interrupted`。
- 写入 `stop_reason=process_interrupted` 等可区分原因。
- 生成 `completed_at`、`duration_ms` 和新的 `terminal_event_sequence`。
- 固化已有 assistant、工具和工作区轨迹。
- 推进 `committed_cutoff`，解除 session 上下文阻塞。
- 恢复过程必须幂等，多次启动不能生成重复消息或重复终态事件。

## P1 一致性项目

- 协作停止与强制取消统一保存已经展示的 assistant 部分文本。
- 正在执行的工具持久化 `cancelled` 终态，而不只发送临时 SSE。
- 明确父 turn Stop 对子 Agent、barrier 和 completion inbox 的处理策略。
- 关闭并持久化尚未消费的 guidance，拒绝终态后的 guidance。
- 持久化 `continued_from_turn_id`、`rerun_of_turn_id`、edit source 等关联字段。
- 将停止 handoff summary 纳入后续 turn 可控的上下文投影。

## 前端已完成的兼容行为

- Stop 后进入 `stopping`，不清空消息、工具、Plan 或文件变更。
- 保持原 SSE，继续接收终态前的合法尾部事件。
- 首个 `done` 后关闭流并忽略迟到事件。
- 若 SSE 终态丢失，750ms 后开始查询 session 历史，最多查询约 10 秒。
- 查询确认终态后才中止残留本地流、恢复输入并发送排队消息。
- stopped 部分 assistant 即使暂未被后端历史返回，也不会被一次历史刷新主动抹掉。
- 重跑/编辑流因已确认终态而中止时，不再回滚到执行前消息。
- 旧 Stop 响应 `{stopped:true}` 与新响应 `{accepted:true}` 均可消费。

## 联合验收矩阵

1. LLM 输出中 Stop：部分文本刷新后仍存在，状态为 stopped。
2. 工具执行中 Stop：已完成工具保留，当前工具为 cancelled，文件副作用可审查。
3. Stop 与正常 done 竞态：只产生一个权威终态，前后端判断一致。
4. Stop 后立即输入：消息在旧 turn 终态后以新 turn 发送，且上下文包含旧 turn。
5. SSE 在 Stop 后断线：历史查询可确认终态，前端不重复提交旧 turn。
6. Stop 后进程硬崩溃：重启归档孤立 turn，session 可继续且历史上下文不被阻断。
7. regenerate/edit 中 Stop：当前执行轨迹保留，不恢复被替代的旧 UI 快照。
8. 多次点击 Stop：只登记一次停止意图，不生成重复终态或重复副作用。

# Turn Guidance 后端对照清单

更新时间：2026-08-12

这份清单用于核对 BushServer 与 CardBush 前端的同一 turn 多轮引导协议。前端以 `message_id` 路由 assistant token，以 `client_message_id` 对账乐观 user 气泡；`turn_id` 只表示生命周期归属，不能作为气泡合并键。

## 1. 引导请求与受理响应

- [ ] 接口接受 `turn_id`、`session_id`、`guidance`、`mode` 和 `message_id`。
- [ ] 请求里的 `message_id` 被视为前端生成的 `client_message_id`，持久化时保持不变。
- [ ] `mode` 允许 `append_context` 和 `interrupt_and_continue`。
- [ ] 两种模式都不会截断正在生成的 model round；当前 round 完成后才进入下一 round。
- [ ] 成功响应包含 `continuation_queued: true`。
- [ ] 成功响应包含 `will_continue_after_current_round: true`。
- [ ] `guidance.client_message_id` 与请求 `message_id` 完全一致。
- [ ] `guidance.mode` 与请求 mode 完全一致。

建议成功响应：

```json
{
  "continuation_queued": true,
  "will_continue_after_current_round": true,
  "guidance": {
    "client_message_id": "client-guidance-01",
    "mode": "append_context"
  }
}
```

## 2. 当前 round 结束信号

- [ ] 当前 assistant 分段继续接收 token，收到引导后不换气泡、不清空、不停止。
- [ ] 当前 round 完成时发送 `execution.kind = loop_transition`。
- [ ] `execution.reason = turn_guidance_pending`。
- [ ] `pending_guidance_count` 是大于等于 1 的整数。
- [ ] `next_round` 是即将开始的 model round 序号。
- [ ] 该 execution 事件携带下一 assistant 分段的 `message_id` 和递增的 `assistant_segment_index`，或保证下一 token 在开始时提供它们。

示例：

```json
{
  "type": "execution",
  "kind": "loop_transition",
  "reason": "turn_guidance_pending",
  "pending_guidance_count": 1,
  "next_round": 2,
  "turn_id": "turn-01",
  "message_id": "assistant-segment-02",
  "assistant_segment_index": 2
}
```

## 3. 下一 assistant 分段

- [ ] 下一 round 使用新的、非空的 `message_id`。
- [ ] `assistant_segment_index` 相对上一分段严格递增。
- [ ] 同一分段内所有 token 的 `message_id` 和 `assistant_segment_index` 保持稳定。
- [ ] token、execution、tool、revision、plan 和 done 事件都尽可能携带同一套分段标识。
- [ ] 多次引导可产生 segment 3、segment 4，仍保持同一 `turn_id`。
- [ ] 不得仅凭 `turn_id` 把不同 round 的文本拼成一个 assistant 消息。

## 4. done 语义

- [ ] `done.assistant_message` 只包含最后一个 assistant 分段的回答。
- [ ] done 不返回由前后多个分段拼接成的全文。
- [ ] done 的 `message_id` 和 `assistant_segment_index` 指向最后分段。
- [ ] done 不会覆盖或改写已完成的旧 assistant 分段。
- [ ] 若无最终文本，done 仍能用分段标识完成当前气泡的状态收尾。

## 5. 历史持久化与刷新恢复

- [ ] 历史顺序稳定为：原始 user → assistant 第一轮 → user guidance → assistant 第二轮。
- [ ] guidance 以 `role: user` 持久化，不使用仅前端可见的临时 role。
- [ ] guidance 保存 `client_message_id`，刷新后可与乐观气泡去重。
- [ ] guidance metadata 至少包含 `turn_guidance: true`、`client_message_id` 和 `mode`。
- [ ] 每个 assistant 分段保存各自稳定的 `message_id` 和 `assistant_segment_index`。
- [ ] 多次引导按真实发生顺序持久化，不集中移动到 turn 末尾。
- [ ] 历史 API 返回的 guidance 不会因为缺少临时 `pending/queued` 状态而被漏掉。

目标顺序：

```text
原始 user
assistant segment 1
user guidance 1
assistant segment 2
user guidance 2
assistant segment 3
```

## 6. 竞态与错误码

- [ ] 空 guidance 或非法 mode 返回结构化 400。
- [ ] turn 不存在或不可用返回结构化 404。
- [ ] session/turn 不匹配返回结构化 409。
- [ ] 引导正好越过 turn 完成边界时返回 409，错误 code 固定为 `turn_guidance_closed`。
- [ ] 错误响应保留机器可读 `code`，不能只返回自然语言文本。
- [ ] `turn_guidance_closed` 不写入半条 guidance 历史；前端会删除乐观气泡并把内容作为普通新 turn 发送。
- [ ] 同一个 `client_message_id` 重试时幂等，不重复插入 guidance。

建议错误结构：

```json
{
  "detail": {
    "code": "turn_guidance_closed",
    "message": "The turn no longer accepts guidance."
  }
}
```

## 7. 事件公共字段

- [ ] 流事件包含可关联的 `session_id`、`turn_id`、`request_id`。
- [ ] 每个事件有单调递增的 `sequence` 或等价顺序保证。
- [ ] 每个事件有稳定 `event_id`，重连或补发时可去重。
- [ ] `created_at` 使用可解析的 ISO 8601 时间。
- [ ] assistant 相关事件包含 `message_id`；跨分段时不得复用旧 ID。
- [ ] `assistant_segment_index` 是正整数，且在单个 turn 内单调递增。

## 8. 最小联调验收矩阵

| 场景 | 后端必须满足 | 前端预期 |
| --- | --- | --- |
| 单次引导 | 当前 round 完成后发 pending transition，再发新 message ID token | 第一轮、引导、第二轮三个气泡顺序稳定 |
| 连续两次引导 | pending count 正确，segment index 连续递增 | 产生两个 guidance 和三个 assistant 分段 |
| 引导时刷新 | 历史已持久化或重连后补齐 | 乐观气泡按 client ID 去重，不消失、不重复 |
| 完成边界引导 | 409 + `turn_guidance_closed` | 自动转普通新消息 |
| token 重放 | event ID/sequence 可去重 | 同一分段不出现重复文本 |
| 最终 done | 只返回最后分段 | 不覆盖前一轮 assistant 气泡 |

## 9. 后端代码核对位置

- `D:/proj/bushserver/src/bushserver/scenes/ui.py`：流事件序列化和分段字段。
- `D:/proj/bushserver/src/bushserver/core_agent/turn_coordinator.py`：引导排队、round 切换、done 生命周期。
- `D:/proj/bushserver/src/bushserver/core_agent/turn_message_state.py`：消息 ID、分段索引和持久化顺序。
- 引导路由：核对成功响应、幂等、404/409 与 `turn_guidance_closed` 结构。

## 10. 完成判定

以下条件同时成立才可认为前后端生命周期闭环：

- [ ] 分段正确：token 永远按 `message_id` 落入对应气泡。
- [ ] 顺序正确：历史稳定为 assistant → guidance → assistant。
- [ ] 收尾正确：done 只结束最后分段，不覆盖整个 turn。
- [ ] 竞态正确：完成边界引导可无损转成普通新 turn。
- [ ] 幂等正确：重试、刷新和重连不产生重复 guidance 或重复 token。

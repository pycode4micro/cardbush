# Chat streaming backend checklist

CardBush now renders token deltas progressively and keeps Markdown tables atomic. The frontend can smooth a final-only snapshot as a fallback, but real-time output still depends on BushServer emitting `token` events while the model is generating.

## Required event order

1. Send `start` as soon as the turn is accepted.
2. Send multiple `token` events during every assistant segment.
3. Send tool and segment-boundary events only after the preceding token sequence has been flushed.
4. Send `assistant_revision` only when content must actually be replaced or a new final transcript is being established.
5. Send `done` once, after the final token, with the complete final answer as the reconciliation snapshot.

## Token contract

```text
event: token
data: {
  "delta": "incremental text only",
  "turn_id": "turn_xxx",
  "message_id": "assistant_xxx",
  "assistant_segment_index": 1,
  "created_at": "2026-08-21T10:00:00Z"
}
```

- `delta` must contain only newly generated text, never the full accumulated answer.
- Keep `message_id` and `assistant_segment_index` stable within one segment.
- When guidance starts a new segment, increment `assistant_segment_index` and use a new `message_id`.
- Do not buffer the entire provider response before forwarding it to SSE.
- Send a heartbeat or connection-state event during long tool/provider waits, but do not synthesize empty token events.

## Final reconciliation

```text
event: done
data: {
  "assistant_message": "complete final answer",
  "turn_id": "turn_xxx",
  "message_id": "assistant_xxx",
  "assistant_segment_index": 1
}
```

- `assistant_message` must exactly equal the concatenation of final-segment token deltas.
- `done` is a reconciliation snapshot, not the primary streaming transport.
- Avoid sending an `assistant_revision` immediately before `done` when it contains the same text already emitted by `token` events.
- If replacement is unavoidable, keep the same routing fields and make the replacement reason explicit.

## Acceptance checks

- The first readable sentence reaches the client before generation completes.
- A 500-character answer produces multiple `token` events over time.
- No token is duplicated or omitted when a tool call begins.
- Markdown tables remain valid after the final snapshot.
- Guidance routes the next round to a new message and segment index.
- Reconnect/replay does not replay already acknowledged deltas as new text.
- The final persisted message equals the text shown before refresh.


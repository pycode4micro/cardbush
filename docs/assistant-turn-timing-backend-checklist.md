# Assistant turn timing backend checklist

CardBush now preserves locally observed turn timing and can approximate old history from transcript timestamps. BushServer should still persist authoritative timing so the display remains exact across devices and after clearing local application data.

## Message fields

Return these fields for every persisted assistant turn, preferably on the final assistant message:

```json
{
  "turn_id": "turn_xxx",
  "started_at": "2026-08-21T10:00:00.000Z",
  "completed_at": "2026-08-21T10:01:42.350Z",
  "duration_ms": 102350
}
```

Equivalent `turn_started_at`, `turn_completed_at`, `turn_duration_ms`, and camelCase forms are accepted. The same values may be placed in `metadata`, but top-level fields are preferred.

## Semantics

- `started_at`: time the backend accepted the turn, not the first token time.
- `completed_at`: terminal time after the final model/tool round is settled.
- `duration_ms`: monotonic elapsed duration measured by the backend; do not derive it from wall-clock timestamps when a monotonic timer is available.
- All assistant segments belonging to one `turn_id` should expose the same turn timing, or at minimum the terminal segment must expose it.
- Guidance-created assistant segments remain part of the same turn and must not reset the timer.
- Rerun creates a new turn and therefore receives a new timing record.

## Required surfaces

- `GET /v1/sessions/{session_id}?include_superseded=true`
- final SSE `done` payload
- persisted message/history projection
- reconnect/replay snapshots

## Acceptance checks

- Restart BushServer and CardBush; completed duration remains identical.
- Refresh the conversation; duration does not become zero or disappear.
- A turn containing tools measures the whole turn, not only summed tool durations.
- Guidance and multi-round turns retain one continuous duration.
- Interrupted, failed, and cancelled turns still persist their terminal time and elapsed duration.


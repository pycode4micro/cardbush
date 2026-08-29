# Runtime facts required by the CardBush product layer

This is a product requirement list, not a protocol schema. The Runtime owner
defines and validates the corresponding values in `bush-protocol`; CardBush only
consumes the resulting decoded types.

## Stable envelope

Every replayable event needs stable identity and ordering facts:

- protocol name and version;
- event ID and monotonic sequence;
- request, session and Turn IDs;
- creation time;
- discriminated event kind;
- structured payload.

The product layer must be able to append or replace by identity. It must not use
rendered text as a deduplication key.

## First integration checkpoint: one streamed Turn

The first fixture set must let the UI represent, in order:

1. Turn accepted and started;
2. reasoning segment started, appended and completed;
3. assistant segment started, appended and completed;
4. terminal outcome with an explicit status and reason.

Assistant and reasoning segments need stable segment/message IDs. A terminal
event must say whether the Turn completed, failed, stopped or requires user
action. Receiving an assistant paragraph or closing a transport stream is not a
terminal fact.

## Tool and permission checkpoint

The product layer needs structured lifecycle facts for:

- tool queued, running, completed, failed and cancelled;
- tool call ID, display metadata and ordered association with assistant segments;
- permission requested, answered, rejected, expired and cancelled;
- Execution Facts and Receipts associated with their originating tool call;
- Artifact and Workspace Change references.

Human-readable summaries may be included for display, but they cannot replace
the machine-readable lifecycle and associations.

An actionable `permission_requested` event must also publish the concrete
capability IDs that may be granted (or structured choices containing those IDs).
The Runtime must reject an allow answer whose granted IDs are not a subset of
that request. CardBush cannot derive capability IDs from action/resource text,
tool names or model output. `permission_answered` must retain whether the user
selected `allow_once` or `allow_session`, so replay restores the same permission
scope. Until those facts are available, the product may safely expose deny and
cancel but must not fabricate an allow request.

## Recovery checkpoint

The UI needs observable facts for:

- provider retry attempt, reason and next delay;
- connection interruption and stream resumption cursor;
- replay reset or superseded branch;
- Turn stopped by user;
- terminal failure after retries are exhausted.

CardBush does not schedule retries and does not submit the original request
again. A recovered event may clear transient UI state without rendering a
separate “recovered” message.

## Coordination checkpoint

Plan, Goal, Subagent and Team updates need independent IDs, revisions and
lifecycle states. In particular:

- Plan progress is not Goal completion;
- a Turn terminal event is not Goal completion;
- a Subagent report is not accepted until the Runtime records its review state;
- historical and live updates use the same decoded structures.

## Capability discovery

The Runtime Host must declare protocol version and supported event/command
capabilities before the product layer enables a feature. Missing capabilities
hide or disable the related UI; CardBush must not probe removed endpoints to
guess support.

## Production boundary

The TypeScript Runtime Host is authoritative. React consumes only decoded shared
protocol facts through typed Electron IPC; there is no local HTTP/SSE adapter,
route-name dependency, snake_case compatibility projection, or HTTP status
convention in the production execution path.

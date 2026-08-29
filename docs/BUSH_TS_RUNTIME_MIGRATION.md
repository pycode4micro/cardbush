# Bush TypeScript Runtime Migration

CardBush owns the production TypeScript Runtime. The frozen Python implementation
at Bush commit `a1e2f2b4` and tag `python-reference-2026-08-29` remains an executable
reference and differential-test oracle during migration.

## Boundaries

- `@cardbush/bush-protocol` owns transport-neutral contracts and frozen-reference
  fixtures.
- `@cardbush/bush-runtime` owns the provider-independent Agent Runtime.
- `@cardbush/bush-provider-openai` adapts OpenAI-compatible wire protocols. It
  disables SDK retries so Runtime recovery remains observable and authoritative.
- React, `src/backend/api.ts`, and Electron `main.ts` do not own the Agent Loop.
- Product integrations such as Browser, Bot, Computer Use, and Office remain MCP
  or CardBush application capabilities rather than Runtime branches.

## Migration order

1. Extract and validate contracts from the frozen Python reference.
2. Normalize provider streams into `bush.model_event.v1`.
3. Implement one provider-independent Turn coordinator.
4. Add tool admission, execution, observation, and authoritative receipts.
5. Add context, Cache Chain, recovery, and persistence.
6. Add Plan, Goal, Subagent, and Team behavior.
7. Put the Runtime behind an Electron utility-process host and typed IPC.
8. Switch production traffic only after historical replay and live A/B gates pass.

Protocol compatibility is evaluated from structured facts, lifecycle events, and
artifacts. Model prose and exact loop counts are observations, not equality keys.

## Product integration checkpoint

`@cardbush/bush-protocol` now exposes `decodeRuntimeEvent` and
`decodeRuntimeCapabilities` for the product-owned `RuntimeClient`. Provider-level
`bush.model_event.v1` remains internal to the Runtime; React consumes the stable
`bush.runtime_event.v1` lifecycle instead.

The first product fixture is
`packages/bush-protocol/reference-fixtures/single-turn-stream.v1.json`. It contains
capability discovery plus a complete accepted → started → reasoning → assistant →
terminal Turn. Its `events` and `commandResponses` fields match the product-side
fixture transport, so the decoded fixture is directly consumable without an
adapter. CardBush does not infer completion from text or stream closure.

`InMemoryRuntimeHost` is the first executable Host boundary. It is structurally
compatible with the product `RuntimeTransport`, publishes monotonically ordered
events, supports cursor replay and live subscription, and makes Provider retries,
attempt supersession, cancellation, and terminal failure observable.

The Host now also executes registered tools through a provider-independent
`ToolRegistry`. Each registration supplies its own input decoder, authoritative
Action Manifest template, optional admission decision, and handler. Runtime only
parses JSON, validates the registration's decoder, verifies Tool Call / Manifest /
Execution Fact identities, and projects lifecycle facts. It never infers effects
from a Tool name or output prose. Interactive permission decisions use a separate
command and concrete capability identifiers; denied or cancelled requests never
invoke the handler. Real application Tool adapters are still pending.

## Durable recovery and Cache Chain checkpoint

The Runtime now has injectable event-journal and checkpoint stores. The file
implementations require an explicit absolute root, use hashed Turn identities for
filenames, checksum every record, and fail closed on complete corruption. Event
records are appended before publication. Token deltas are written immediately,
while `fsync` is reserved for lifecycle boundaries so durability does not add a
disk flush to every streamed token. An incomplete final journal record can be
removed mechanically after a process crash; complete invalid records are never
guessed or repaired.

The stable checkpoint contains the exact provider-independent request, current
messages, completed receipt identifiers, and a hash-only Cache Chain snapshot.
Restart recovery supersedes partial provider output and resumes from that stable
request. If a Tool or permission lifecycle advanced after the checkpoint, Runtime
blocks automatic resume instead of re-dispatching a possibly completed effect.
The renderer-facing recovery inspection exposes only status, cursor, round, and
event identifiers; raw checkpoint messages remain inside the Runtime process.

Cache Chain observation compares the real provider request structure and ordered
message hashes. It reports append-only prefix continuity and exact break position,
but never classifies a task, Tool name, programming language, or output prose. The
Python reference's name-based Cache heuristics are intentionally not migrated.

The Utility Process enables file-backed recovery only when
`CARDBUSH_RUNTIME_STATE_ROOT` is an absolute directory. Choosing the production
state root remains a CardBush product-host responsibility; the Runtime does not
invent or migrate product data locations. The Electron main process now supplies
`<app userData>/runtime-state`, while tests use isolated system-temporary roots.

Provider credentials use a separate typed control path. The product registers an
OpenAI-compatible configuration with `runtime.upsert_provider_binding`; the
Utility Process returns only an opaque binding ID and deterministic revision.
Model Requests, Cache Chain state, event journals, and checkpoints contain this
reference but never the API key or headers. Identical configuration produces the
same revision after restart so a durable checkpoint can resume once the product
registers its settings again. Changed configuration creates a different revision,
preventing an active Turn from silently switching provider behavior between
rounds.

## Electron live-host checkpoint

The Electron boundary consists of four isolated pieces:

- `electron/runtimeHostWorker.mts` owns the live `InMemoryRuntimeHost` inside an
  Electron Utility Process.
- `electron/runtimeHostController.mts` owns Utility Process lifecycle and routes
  typed command/stream messages in the main process.
- the preload exposes `window.cardbushDesktop.runtime` as a delivery-only bridge;
  it does not decode or infer Runtime state.
- `@cardbush/bush-runtime-electron` implements the product-compatible
  `RuntimeTransport` over that bridge.

The live IPC contract is `bush.runtime_ipc.v1`. A capability or envelope version
mismatch returns `bush.runtime_error.v1` with the stable
`protocol_version_mismatch` code. Clean `build` and `typecheck` commands build all
Runtime workspace packages first, so Electron and Vite never depend on stale
local `dist` output.

Product model settings now cross typed IPC through an opaque provider binding.
Secrets remain inside the Utility Process registry and never enter Model Requests,
event journals, checkpoints, Cache Chain state or renderer-visible results.

## Session and authoritative Tool facts checkpoint

Session history is an append-only checksummed journal. A Turn is committed once
with ordered message identity and usage; history changes require explicit message
supersession. Context assembly appends fixed prefix, committed messages and current
input without percentage thresholds, summaries or semantic selection.

Tool execution now has a separate authoritative record containing the admitted
Action Manifest, exact ToolResult, Execution Facts, Artifacts and Workspace
Changes. Tools declare these values; Runtime validates identities and publishes
their IDs without parsing output prose or dispatching on Tool names. Records are
queryable through typed Runtime commands and persist under the Utility Process
state root.

## Plan and Goal fact checkpoint

Plan and Goal state now cross the same typed Runtime command boundary and use a
checksummed append-only Coordination journal. Updates use optimistic revisions,
stable Session/Plan/Goal identities, and Runtime-assigned IDs for Plan nodes that
arrive without one. Removing a previously identified Plan node requires the
caller to submit an explicit scope-change reason; Runtime records that declaration
but does not interpret it.

Goal status and reason are caller-declared facts. Runtime validates their schema,
identity, and revision, then preserves them verbatim. It does not inspect user or
assistant prose, Tool names, Plan-node combinations, or Execution Facts to decide
whether a Goal is complete. Automatic Goal continuation remains a later behavior
checkpoint built on these facts.

The model-facing `update_task_plan` and `update_goal` registrations inject
Session identity, stable Plan/Goal identity, and optimistic revision inside the
Runtime. Models submit only their declared state. A typed Tool Catalog exposes the
actual registered schemas to the product; React does not duplicate them and the
Runtime does not discover them by parsing prompt text.

## Subagent fork checkpoint

`subagent` is now a Runtime-registered root-only delegation Tool. It forks the
parent's model-visible conversation immediately before the dispatch call, removes
root System/Developer instructions, adds only explicitly supplied child prefix
messages, and appends the assignment as a new User message. Child-visible Tools
are the intersection of the parent's selected catalog and registrations that
explicitly declare child visibility. A fabricated call to a hidden Tool is
mechanically rejected even if a provider emits its name.

Registrations declare `parallelSafe` directly. A same-round batch runs concurrently
only when every registration in that batch makes that declaration; Runtime does
not infer safety from Tool names, language, task text, manifests, or state
combinations. Results remain ordered by the original Tool Call batch.

ToolResult now has a structured `guidance` channel. Subagent terminal responses
are persisted in a checksummed task journal and re-enter the parent after all Tool
receipts as User guidance, without parsing output prose. Child sessions use the
same Session/Turn/Provider/Tool loop and durable stores as root sessions. Team
configuration and peer discussion remain a separate product-owned checkpoint.

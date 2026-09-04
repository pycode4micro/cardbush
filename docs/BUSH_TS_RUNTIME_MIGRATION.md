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
- Product integrations such as Browser and Office remain optional MCP or CardBush
  application capabilities rather than Runtime branches. Bot products are fully
  independent MCP projects; CardBush neither embeds nor manages them.

## Migration order

1. Extract and validate contracts from the frozen Python reference.
2. Normalize provider streams into `bush.model_event.v1`.
3. Implement one provider-independent Turn coordinator.
4. Add tool admission, invocation lifecycle, native results, and workspace changes.
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
`ToolRegistry`. Each registration supplies its own input decoder, Action Manifest
template, optional admission decision, and handler. Runtime only parses JSON,
validates the registration's decoder, preserves the native return, and projects
invocation lifecycle facts. It never infers effects
from a Tool name or output prose. Interactive permission decisions use a separate
command and concrete capability identifiers; denied or cancelled requests never
invoke the handler. Product extensions do not enter through a private host-tool
bridge. The bundled `cardbush_apps` process provides Computer Use through the
same MCP Tool Registry used by external extensions. Bot delivery, Browser, and
other optional integrations also enter through MCP.

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
messages, and a hash-only Cache Chain snapshot.
Restart recovery supersedes partial provider output and resumes from that stable
request. If a Tool or permission lifecycle advanced after the checkpoint, Runtime
blocks automatic resume instead of re-dispatching a possibly completed effect.
The renderer-facing recovery inspection exposes only status, cursor, round, and
event identifiers; raw checkpoint messages remain inside the Runtime process.

Cache Chain observation compares the real provider request structure and ordered
message hashes. It reports append-only prefix continuity and exact break position,
but never classifies a task, Tool name, programming language, or output prose. The
Python reference's name-based Cache heuristics are intentionally not migrated.
The final hash-only snapshot is stored with each committed Turn and seeds the next
Turn in that Session. A stopped Turn therefore remains an ordinary append-only
prefix; edit/regenerate inherits the same snapshot but truthfully reports the
edited prefix as a break.

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

## Session and native Tool result checkpoint

Session history is an append-only checksummed journal. A Turn is committed once
with ordered message identity and usage; history changes require explicit message
supersession. Context assembly appends fixed prefix, committed messages and current
input without percentage thresholds, summaries or semantic selection.

Tool execution now has a separate record containing the admitted Action Manifest,
the exact native Tool return value, Runtime-owned Workspace Changes, or a Runtime
invocation error. Runtime validates JSON transport and lifecycle identities only;
it does not wrap returns in a private ToolResult, create semantic facts, reinterpret
MCP `isError`, or extract effects from output prose. Records are queryable through
typed Runtime commands and persist under the Utility Process state root.

## Plan and Goal fact checkpoint

Plan and Goal state now cross the same typed Runtime command boundary and use a
checksummed append-only Coordination journal. Updates use optimistic revisions,
stable Session/Plan/Goal identities, and Runtime-assigned IDs for Plan nodes that
arrive without one. Removing a previously identified Plan node requires the
caller to submit an explicit scope-change reason; Runtime records that declaration
but does not interpret it.

Goal status and reason are caller-declared facts. Runtime validates their schema,
identity, and revision, then preserves them verbatim. It does not inspect user or
assistant prose, Tool names, Plan-node combinations, or Tool returns to decide
whether a Goal is complete. Goal continuation is implemented by the product caller
as consecutive normal Session Turns built on these facts.

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

Subagent terminal responses are persisted in a checksummed task journal. Async
completion enters the parent through the Runtime's explicit child-result boundary;
explicit joins return native Tool data. Dispatch does not block subsequent
independent parent rounds. A parent terminal attempt is
a mandatory join barrier: Runtime waits for remaining children, injects their
results, and runs parent reconciliation before committing the terminal fact.
`await_subagents` exposes the same join explicitly when the parent has no useful
independent work left; repeated status polling is neither required nor encouraged.
Child sessions use the same Session/Turn/Provider/Tool loop and durable stores as
root sessions. Team configuration and peer discussion remain a separate
product-owned checkpoint.

## Goal continuation checkpoint

The product Runtime Client now implements Goal continuation as consecutive normal
Session Turns rather than one unbounded internal Loop. After each `turn_terminal`
it reads the typed Goal fact. Only an explicit `active` declaration causes the
caller-supplied continuation prompt to be appended as a new User message with new
Runtime-owned request, Turn and message IDs. `complete`, `blocked`, `cancelled`, a
non-completed Turn, or cancellation stops the runner mechanically. There is no
elapsed-time, action-count, token-percentage or semantic completion classifier.

Each Turn retains its own stream and durable commit, so interruption never hides
the last completed Turn and the UI can display progress one Turn at a time.

## Workspace execution checkpoint

The Runtime now registers `read_file`, `search_file_content`, `write_file`,
`edit_file`, `terminal_exec`, `terminal_poll`, `terminal_write`, `terminal_list`,
and `terminal_stop` from one typed workspace Tool module. Paths are
canonicalized before workspace admission, including linked workspace roots and
linked-directory escapes. Existing file writes require a matching SHA-256 read
observation from the current Agent context or its explicit parent fork. An
external modification invalidates that observation without a text or language
classifier.

External operations request action-and-resource-bound capability IDs. The
permission broker accepts an allow answer only when it grants exactly the set the
Tool requested; replacing the resource or capability keeps the request pending.
Workspace changes contain authoritative paths and revision hashes. Line counts
are omitted for modified files until an exact diff producer is attached rather
than publishing approximate facts.

Terminal execution remains intentionally transparent: Runtime performs no shell,
language, command, service, or intent classification. A command that outlives
the declared yield window returns a stable terminal session handle, so the Agent
Loop can continue while the process remains active. Follow-up Tools poll output,
write stdin, list owned sessions, or explicitly stop a process tree. Permission
admission covers the selected canonical cwd, while stopping requires an exact
process capability; neither is inferred from command text. This checkpoint
therefore preserves the product's explicit non-sandbox boundary instead of
implying an enforcement guarantee that the process host does not provide.

## MCP client checkpoint

MCP configuration is a product-owned `bush.mcp_snapshot.v2` fact. The Electron
Runtime accepts a complete snapshot only between Turns, connects it with the
official TypeScript MCP 2.x client using `auto` negotiation by default, and
atomically replaces the corresponding Tool registrations. Modern
`2026-07-28` and legacy servers therefore share the SDK negotiation path instead
of a CardBush compatibility parser.

Each configured server supplies explicit default and per-Tool permission,
parallel-safety, and child-visibility policy. Runtime never derives those values
from the Tool name, description, annotations, task text, or lifecycle-state
combinations. Remote Tool names receive a deterministic server namespace. MCP
results cross the boundary unchanged as native `CallToolResult` values; Runtime
does not impose a private result schema or scrape result prose for paths,
Artifacts, or workspace changes. Reusing a snapshot revision with different content, moving a
revision backwards, changing configuration during a Turn, or colliding with a
Tool owned by another source fails closed while the previous snapshot stays live.

## Team execution checkpoint

Team configuration is likewise a product-owned, revisioned
`bush.team_snapshot.v1` fact. It explicitly names Teams, members, roles,
fallback membership, Profile instructions, disabled Tools, Skills, trusted
Hooks/Guards, and child-visible Tool allowlists. Runtime does not infer any of
these from the task or member prose, and configuration cannot change while a
Turn is active.

`subagent` and `team_delegate` share one child-Turn builder and the same durable
Session, Provider, Tool, permission, and task-journal path. Explicit assignments
run independently; the parent model owns selection and sequencing. Runtime has
no conference, peer chat, implicit DAG, fallback routing or semantic retry. It
performs only mechanical identity, exposure and completion checks.

Older Subagent journals remain byte-compatible: Team origin and phase fields are
optional when reading historical records and are written explicitly for every
new task, so schema evolution does not invalidate existing checksums.

## Product Host and secret ownership checkpoint

Provider credentials are owned by the typed Electron Product Host. Computer Use
is owned by the independent bundled `cardbush_apps` MCP process and returns a
standard MCP result with explicit native artifacts. Bot
configuration, adapters, inbound media, delivery, accounts and management UI are
not CardBush product capabilities; an independent Bot may expose `deliver`
through that same generic registry.

Provider keys are atomically persisted under the Product Host data root. Renderer
configuration reads contain only `hasApiKey` and a masked value. Before a desktop
Turn, the Product Host resolves the selected model, installs the credential inside
the Utility Process and returns only an opaque provider binding reference. Keys do
not enter Renderer persistence, Model Requests, Session journals or Cache Chain
observations.

Dynamic per-Turn facts such as local date, project path, project instructions and
attachments are added as a non-persisted developer prefix for the current request.
They are never represented as user intent or committed into Session history.

## Live provider checkpoint

The TypeScript Runtime was exercised against the configured
`deepseek-v4-flash-vision-exp` provider on a system-temporary copy of the Game
project. The complex run produced Python and Rust transcript implementations;
independent verification passed 42 Rust unit tests, 5 Rust integration tests,
and byte-identical cross-language JSON for six deterministic seeds. That run also
exposed one provider-boundary incompatibility: some OpenAI-compatible Chat
Completions services reject the newer `developer` role used by an internal
Runtime reminder. The adapter now projects that internal role mechanically to
the universally supported `system` role without changing the Runtime protocol.

A post-fix write Turn completed naturally in 83 seconds with no provider retry,
recorded the Runtime-owned Workspace Change, and reported the output path as an
absolute path. The original source project was not modified by either run.

## Product cutover completion checkpoint

The CardBush production path no longer connects to the Python service for Agent
execution, Session history, Shadow conversations, workspace changes, context
usage, Goal, Plan, Subagent, Team, permissions or provider
recovery. React uses one typed Runtime Client; Electron owns the Utility Process
Runtime Host and typed Product Host commands. The removed HTTP/SSE payload
parsers and backend settings are not retained as a compatibility layer.

Shadow conversations are hidden, temporary Runtime Sessions with an explicit
source-Turn boundary, frozen source revision and a read-only Tool selection.
Assistant timing comes from committed Runtime Turn timestamps. Media rendering
reads only explicit native `artifacts`, MCP `structuredContent.artifacts`, or MCP
media/resource content blocks; it does not infer paths from response text or
arbitrary nested JSON. Bot/channel ownership is outside CardBush and may integrate
only as an independent MCP server.

The complete product release gate passes after the cutover, including protocol,
Runtime, provider, MCP, Electron IPC, Product Host, Goal, Shadow,
Subagent, Team, permission, recovery, typecheck, production build and packaged
release-cleanup checks.

A final live `deepseek-v4-flash-vision-exp` Turn ran against a system-temporary
copy of the Game project. It added a persisted and bounded configurable War
face-down count to both Python and Rust implementations, preserved the default
behavior, emitted the actual count as an event fact and added boundary and
save/load tests. Independent verification passed 18 Python tests and 63 Rust
tests; the original Game source hash manifest remained unchanged. The Turn
completed naturally in 762 seconds over 47 rounds with no provider retry. It used
3,527,304 input tokens, of which 3,412,352 were provider-cache hits (96.74%), and
81,088 output tokens. This validates behavior and isolation while also recording
that complex cross-language convergence remains a model-efficiency concern rather
than hiding it behind a local hard timeout.

# CardBush Runtime Client boundary

This directory belongs to the CardBush product layer. It adapts structured
Runtime protocol values for React features without implementing Agent Runtime
semantics.

The shared `@cardbush/bush-protocol` package remains the source of truth.
`ProtocolRuntimeClient` injects its event and capability decoders into the
transport-neutral `RuntimeClient`; this directory does not duplicate protocol
schemas.

Allowed responsibilities:

- open a typed Runtime event stream through an injected transport;
- send typed commands through an injected transport;
- expose fixture transports for product and visual tests;
- forward cancellation to the host transport.

Forbidden responsibilities:

- infer state from assistant text or tool names;
- decide whether a Turn, Goal or Subagent is complete;
- retry model or tool requests;
- reorder, merge or fabricate Runtime events;
- access Runtime SQLite storage;
- implement permission or Execution Fact rules.

`FixtureRuntimeTransport` deliberately accepts raw fixture values.
`createRuntimeFixtureClient` validates the complete fixture through the
Runtime-owned decoder before any feature receives it, so fixture UI work fails
at the same contract boundary as the live Runtime Host. `RuntimeTurnProjection`
then projects those validated facts into separate reasoning and assistant
segments and only applies a terminal phase from `turn_terminal`.

`ElectronRuntimeSession` binds the same product projection to
`window.cardbushDesktop.runtime`. It starts the event subscription before the
Turn command, keeps the stream attached during user cancellation so the
Runtime-owned stopped terminal can arrive, and never converts IPC failures into
model or network prose. React should subscribe to its `RuntimeTurnStore`; it
must not call preload IPC methods directly.

Tool and permission events are projected by stable call/permission identity.
Receipt, Execution Fact, Artifact and Workspace Change references remain
separate arrays; rendered tool output is never inspected to manufacture them.
Permission answers are validated against `bush.runtime_permission_answer.v1`
before IPC. The allow UI remains gated until `permission_requested` publishes
the concrete capability IDs that the user is allowed to grant.

Provider credentials cross the typed IPC boundary only through
`runtime.upsert_provider_binding`. The Utility Process returns an opaque
`bindingId + revision`; only that reference enters a Model Request, checkpoint,
or event journal. Reconfiguring a binding creates a new immutable revision, so
an active Turn cannot silently switch provider configuration between rounds.
The revision is a deterministic one-way fingerprint of the exact configuration:
registering the same configuration after an app restart restores the same
checkpoint reference without persisting the credential in Runtime state.

Session history is exposed only through typed Runtime commands.
`ProtocolRuntimeClient.getSession`, `assembleSessionContext` and
`runSessionTurn` decode `bush.session_*` contracts; they do not read the Runtime
journal or assemble messages in the renderer. The Runtime owns append order,
explicit supersession, crash recovery and atomic Turn commit. The existing
product chat path is not switched by merely exposing these methods.

`GoalContinuationRunner` composes ordinary durable Session Turns. It observes only
the typed Goal status returned by Runtime and appends a caller-supplied User
continuation while that status remains `active`; it does not infer completion from
assistant text, Plan nodes, Tool names, elapsed time or loop counts.

# Bush TypeScript Runtime

This package owns the provider-independent Agent loop. It does not render UI,
manage product settings, or infer task semantics from text, tool names,
languages, frameworks, or combinations of lifecycle states.

## Session and context boundary

`SessionStore` is an append-only fact journal. A Turn is committed atomically
with stable Turn/message identity, ordered indexes, terminal status, reason and
provider usage. Reusing the same Turn ID is accepted only when every committed
fact is identical. Replacing history requires an explicit
`messages_superseded` event with referenced message IDs and a reason.

`RuntimeSessionCoordinator` prepares a model request from:

1. the caller's fixed prefix;
2. ordered committed messages that were not explicitly superseded;
3. the current Turn input.

`assembleContext` never mutates committed messages. A Turn may later receive an
immutable `contextSummary` through one append-only `turn_context_summarized`
event; model context then projects that Turn as one internal semantic summary,
while history replay, audit and Fork continue to read the original message and
Tool facts. Tool call/result adjacency is validated mechanically.

`checkpoint_context` is always present in the stable Tool schema. At 85% of the
usable input budget Runtime emits one optional internal pressure notice; at 95%
it temporarily requires that Tool before normal work can continue. One atomic
checkpoint must summarize every still-unsummarized preceding Turn in order and
never summarizes the active Turn. If fully summarized context later still
reaches 95%, projection keeps the newest 20 summaries and drops older summaries
from active model context only. Durable history is never deleted.

Session events are checksummed JSONL records. Complete corruption fails closed;
only an incomplete final record may be removed after a crash. A Session-aware
checkpoint also retains generated-message identity and accumulated usage, so a
Turn interrupted after tool execution can resume and commit exactly once. The
desktop Product Host settles checkpoints orphaned by a process crash as stopped
Turns during startup and releases the Session single-active-Turn gate.

Stop is a Loop boundary, not a history rollback and not an implicit process
shutdown. Runtime aborts the active Provider/Tool wait, allows a uniform 250 ms
grace for a cooperative native stop fact, then projects exactly one cancelled
Tool fact where needed and commits the interrupted Turn with any assistant
text and completed Tool facts already observed, and releases the Session for the
next Turn. Provider or Tool promises that ignore Abort are detached and their late
settlement cannot append a second lifecycle fact. A following user message is
assembled after the stopped Turn, while its hash-only Cache Chain snapshot is
carried into the next Turn so append-only prefix continuity remains observable.
Explicit message edit/regenerate still uses supersession; the inherited tracker
then reports the actual prefix break rather than hiding it.

The live Utility Process stores Runtime events, checkpoints and Session facts
under separate directories beneath its explicit state root. Tool execution also
has a checksummed journal containing the admitted manifest, exact native result,
Runtime-owned Workspace Changes, or a Runtime invocation error. Runtime never
creates semantic result facts, interprets MCP `isError`, or extracts paths and
effects from output text. The Electron product chat path consumes these records
directly; ordinary Turns no longer need a Python HTTP/SSE adapter. Large
Tool results remain complete in that journal; the model sees a bounded projection
and can retrieve exact excerpts from a stable `tool-result://` locator through
`read_archived_tool_result`. That reader accepts only an exact locator emitted by
the Runtime projection; it is not a general file, Skill or knowledge reader.

Plan and Goal state is stored separately in an append-only Coordination journal.
The store enforces only protocol identities, monotonic revisions, stable Plan
node IDs, and explicit scope-change declarations. Semantic completion remains a
model/caller declaration; Runtime does not derive it from prose or lifecycle
state combinations.

`update_task_plan` and `update_goal` are ordinary registered Tools. Their Session,
identity and revision fields are supplied by Runtime rather than the model. The
typed Tool Catalog is the sole source of their model-visible definitions.

Normal assistant terminal text completes the Turn. Runtime keeps invocation state
and recorded Workspace Changes authoritative for its own lifecycle; tool-owned
meaning remains inside the native return and terminal prose is never promoted
into an execution fact.

Subagent execution forks the exact pre-dispatch conversation into an ordinary
child Session Turn. Dispatch returns a submitted fact immediately and child work
runs in the background while the parent continues independent model and Tool
rounds. Completed child output enters the parent only at a round boundary. If the
parent attempts to finish with active children, Runtime joins them, injects their
terminal results, and requires one reconciliation round before committing the
parent terminal fact. The parent may call `await_subagents` once when no useful
independent work remains; this is an explicit join rather than status polling.
Tool registrations explicitly declare child visibility and parallel safety;
Runtime does not derive either property. Subagent lifecycle facts are stored in a
checksummed append-only journal and are queryable through typed commands.

The default workspace Tool set provides exact file reads, ripgrep search, guarded
file creation/replacement, exact-text edits, and terminal execution. Existing
files can be changed only after the current SHA-256 revision has been observed by
that Agent context; a Subagent may inherit unchanged observations from its parent
fork. Canonical paths and linked directories are resolved before deciding whether
an operation is inside the workspace. External access requests one capability
bound to the exact action and canonical resource, and an allow answer must grant
exactly that requested capability set.

Runtime does not parse, classify, or rewrite terminal commands. `terminal_exec`
returns completed output and exit status when the command finishes inside its
declared yield window; otherwise it returns `state=running` with a stable
terminal session handle. `terminal_poll`, `terminal_write`, `terminal_list`, and
permission-gated `terminal_stop` manage that handle without blocking the Agent
Loop. Cancelling a wait does not implicitly stop the spawned terminal session.
Consequently this workspace permission protocol controls declared paths and the
terminal working directory; it is not an operating-system sandbox and does not
claim to constrain paths that a command itself may access.

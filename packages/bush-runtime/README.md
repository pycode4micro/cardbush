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

`assembleContext` performs no summarization, relevance classification,
language-specific routing, percentage threshold, read-count limit or implicit
message removal. Tool call/result adjacency is validated mechanically.

Session events are checksummed JSONL records. Complete corruption fails closed;
only an incomplete final record may be removed after a crash. A Session-aware
checkpoint also retains generated-message identity and accumulated usage, so a
Turn interrupted after tool execution can resume and commit exactly once.

The live Utility Process stores Runtime events, checkpoints and Session facts
under separate directories beneath its explicit state root. Tool execution also
has a checksummed journal containing the admitted manifest, exact result,
Execution Facts, Artifacts and Workspace Changes. Event references come only
from those declared facts; Runtime never extracts paths or effects from output
text. The Electron product chat path now consumes these typed Session and Tool
facts directly; ordinary Turns no longer need a Python HTTP/SSE adapter.

Plan and Goal state is stored separately in an append-only Coordination journal.
The store enforces only protocol identities, monotonic revisions, stable Plan
node IDs, and explicit scope-change declarations. Semantic completion remains a
model/caller declaration; Runtime does not derive it from prose or lifecycle
state combinations.

`update_task_plan` and `update_goal` are ordinary registered Tools. Their Session,
identity and revision fields are supplied by Runtime rather than the model. The
typed Tool Catalog is the sole source of their model-visible definitions.

`declare_turn_outcome` is the only product Turn-finalization protocol. The model
declares the disposition and complete visible response; Runtime validates cited
receipts against authoritative records and projects the response without
classifying its prose. `effect_complete` requires a successful cited Action
Manifest that explicitly declares an effect. A missing declaration receives one
protocol reminder, whose count is included in the recovery checkpoint, then
fails explicitly if omitted again. The legacy Python outcome-finalizer semantic
classification shape is intentionally not part of the TypeScript protocol.

Subagent execution forks the exact pre-dispatch conversation into an ordinary
child Session Turn. Tool registrations explicitly declare child visibility and
parallel safety; Runtime does not derive either property. Child terminal output
returns through ToolResult `guidance` as a User message after the complete Tool
receipt batch. Subagent lifecycle facts are stored in a checksummed append-only
journal and are queryable through typed commands.

The default workspace Tool set provides exact file reads, ripgrep search, guarded
file creation/replacement, exact-text edits, and terminal execution. Existing
files can be changed only after the current SHA-256 revision has been observed by
that Agent context; a Subagent may inherit unchanged observations from its parent
fork. Canonical paths and linked directories are resolved before deciding whether
an operation is inside the workspace. External access requests one capability
bound to the exact action and canonical resource, and an allow answer must grant
exactly that requested capability set.

Runtime does not parse, classify, or rewrite terminal commands. It records the
selected working directory, complete output, exit code, and timeout as Tool facts.
Consequently this workspace permission protocol controls declared paths and the
terminal working directory; it is not an operating-system sandbox and does not
claim to constrain paths that a command itself may access.

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
text. Existing CardBush
chat remains unchanged until the typed Session Turn path passes product A/B
gates.

Plan and Goal state is stored separately in an append-only Coordination journal.
The store enforces only protocol identities, monotonic revisions, stable Plan
node IDs, and explicit scope-change declarations. Semantic completion remains a
model/caller declaration; Runtime does not derive it from prose or lifecycle
state combinations.

`update_task_plan` and `update_goal` are ordinary registered Tools. Their Session,
identity and revision fields are supplied by Runtime rather than the model. The
typed Tool Catalog is the sole source of their model-visible definitions.

Subagent execution forks the exact pre-dispatch conversation into an ordinary
child Session Turn. Tool registrations explicitly declare child visibility and
parallel safety; Runtime does not derive either property. Child terminal output
returns through ToolResult `guidance` as a User message after the complete Tool
receipt batch. Subagent lifecycle facts are stored in a checksummed append-only
journal and are queryable through typed commands.

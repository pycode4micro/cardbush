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
under separate directories beneath its explicit state root. Existing CardBush
chat remains unchanged until the typed Session Turn path passes product A/B
gates.

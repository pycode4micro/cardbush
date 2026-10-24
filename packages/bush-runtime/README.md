# Bush TypeScript Runtime

This package owns the provider-independent Agent loop. It does not render UI,
manage product settings, or infer task semantics from text, tool names,
languages, frameworks, or combinations of lifecycle states.

## Model failure boundary

`modelFailurePolicy.ts` classifies normalized failures for both the execution
loop and buffered assistant rounds. HTTP status and structured error codes
control the decision; arbitrary error prose cannot enable a transport retry.

| Failure | Action |
| --- | --- |
| HTTP 408 / 409 / 429; 5xx except 501 / 505 | Retry the current model round with backoff and bounded `Retry-After` |
| Connection interruption, timeout, missing stream terminal, recognized transient SSE error | Same transport retry path |
| Authentication, exhausted quota, other permanent HTTP/input failures, unknown SSE error | Stop and retain the original reason |
| Recognized context overflow | Existing bounded context-compaction recovery |
| Invalid/incomplete tool call | Existing one-correction path before any call in that batch executes |

A provider may explicitly forbid retry, for example for an account entitlement
limit returned as HTTP 429. A `retryable: true` flag cannot override a permanent
HTTP status or turn context/tool repair into an ordinary connection retry.

`ModelRequestAttempts` belongs to one unchanged model round and is reused across
its transport retries. It grants at most one wire-only recovery for missing
continuation state or unsupported optional capabilities. The adapter keeps that
recovery applied after a later transient fault; different recovery actions do
not receive independent allowances. For a finite transport cap of N, there are
at most N + 1 generation dispatches, rather than nested retry multiplication.
Existing retry settings remain in force: the main loop accepts a finite cap or
`null` for sustained retries; buffered assistant rounds stop after three attempts.
Cancellation interrupts backoff and prevents further dispatches.

Failed attempt output is superseded; previously completed tools and their
durable results remain authoritative. Neither wire recovery nor transport retry
dispatches tools. Retry and compatibility diagnostics record actual generation
`providerAttempts` and `recoveryAttempts`, separately from outer retry numbering.

## Session and context boundary

Product conversational features also use `ConversationJournal` for entries with
explicit source and visibility. Final voice transcripts, page publications and
task feedback are appended independently of execution Turns; reading them does
not take the active Turn lock. Entry IDs deduplicate retries, and the personal
assistant's context generation rejects late writes after a reset.

`AssistantConversation` uses the shared model-round adapter with five restricted
conversation tools. `RealtimeAgentDispatcher` sends execution to the existing
subagent tool and durable Session loop, using the configured workspace and
permission policy. Task reads and follow-ups keep the child's original host;
resetting the conversational parent does not cancel already dispatched children.
Conversation summaries retain original journal entries and are separate from
cross-session habit memory. See the [assistant guide](../../docs/PERSONAL_ASSISTANT.md)
and [realtime voice boundary](../../docs/REALTIME_VOICE.md).

`SessionStore` is an append-only fact journal. A Turn is committed atomically
with stable Turn/message identity, ordered indexes, terminal status, reason and
provider usage. Reusing the same Turn ID is accepted only when every committed
fact is identical. Replacing history requires explicit referenced message IDs
and a reason. Standalone replacements use `messages_superseded`; edit/rerun
requests carry a revision-checked `supersession` that is projected only for the
active Turn and committed atomically inside its `turn_committed` record. Failed
preparation leaves the original effective history intact. The Session checkpoint
retains this replacement intent for recovery without replaying old work.

`RuntimeSessionCoordinator` prepares a model request from:

1. the caller's fixed prefix;
2. ordered committed messages that were not explicitly superseded;
3. the current Turn input.

`assembleContext` never mutates committed messages. A Turn may later receive an
immutable `contextSummary` through one append-only `turn_context_summarized`
event; model context then projects that Turn as one internal semantic summary,
while history replay, audit and Fork continue to read the original message and
Tool facts. Tool call/result adjacency is validated mechanically.

Recorded tool handoffs are the default in the shared desktop, server Agent and
CLI runtime. No per-Turn summary call or extra model-authored field is required.
At pressure the host derives a projection from completed Turns: tool names,
existing reason/display titles, arguments, observed results and exact final
replies. User instructions and corrections keep their original order. A returned
tool is never labeled as business success. Failed and pending results, nested
batch statuses, IDs, permissions and unknown metadata are retained. Large known
text payloads may become explicit head/tail excerpts with original-history
locators; unknown plain text and failure diagnostics stay whole. Skill source
exchanges, instruction files, image exchanges and existing checkpoints stay intact.

The whole rebuilt request must shrink and meet the existing token headroom and
body limits before applying. Otherwise the ordinary model checkpoint below is
used, including for unfinished active Turns. An immutable `recorded_v1` reference
and source digest are saved through `turn_context_summarized`; original messages
remain available for history, audit and fork. Restart reconciles applied references
without replaying business tools. `preferRecordedToolHandoffs: false` disables the
new path for comparisons. The historical `preferPreparedToolHandoffs` option is
opt-in; applied model-authored handoffs and old frozen calls remain readable.
The default `summary_for_user` schema now contains only optional habit/prediction
fields. Legacy `tool_summary` input is accepted for compatibility, not requested.
After other tool work is finished, product prompts ask for a standalone call
before the final reply so it can stream with final-display intent. Use `{}` when
memory is disabled or there is nothing new to record. Conversation without tool
work needs no call. This signal neither ends the loop nor prepares compaction;
the host does not insert a missing call or block completion without it.

Product policy v4 migrates bound v2/v3 conversations once at the next Turn boundary,
refreshing the system policy and `summary_for_user` presentation only. The change
is recorded as `model_contract_updated`; other tools and original conversation
facts remain unchanged. Running loops retain their snapshot. This one-time
policy/schema change can invalidate a cached prefix; it is not a per-Turn change.
See [the recorded-compaction implementation and live evaluation](../../docs/RECORDED_TOOL_COMPACTION_2026-10-23.md).

Finishing a Turn does not immediately replace history or rewrite the next
request's prefix. Only actual context pressure applies it. Ordinary append-only
requests before and after that boundary retain the prior message prefix and
fixed model/Tool parameters. Prefix diagnostics describe structural changes;
only provider usage establishes cache hits. A compaction boundary can invalidate
part of a cached prefix even when it needs no additional model request.

`checkpoint_context` is always present in the stable Tool schema and Runtime
never narrows the Tool list for a compaction round. The model must not invoke it
proactively. Runtime issues an explicit developer-role maintenance notice at the
input-pressure threshold calculated by `resolveContextBudget`, reserving room
for a separate checkpoint response and safety margin before the normal input cap.
The normal output reserve is also enforced on Provider dispatch; an omitted limit
uses the same bounded default (at most 8,192 tokens).

The default incremental schema accepts `updates` for pending source numbers
supplied in the current source index. Valid entries survive mixed invalid entries, while accepted
text cannot be overwritten. A checkpoint is applied only after every authorized
source is complete, including any cumulative active-Turn source through its exact
boundary. Fresh incremental transactions present one historical source at a time,
with prior accepted summaries as background and the real current user input kept
outside the historical source range. The current message index follows earlier
receipts so frozen original positions cannot override remapped dispatch positions.
Interrupted older transactions keep their saved input mode. Requests that exceed the input budget, or an explicitly configured
transport budget, partition at complete message/Tool-exchange boundaries. Staged
fragments retain global source numbers; the model consolidates them before a whole
source is accepted. Earlier completed fragments provide background for references
and authorization without reattaching their raw images. Real model calls, receipts
and partition boundaries survive restart; a smaller dispatch projection never
replaces the canonical history. Complete exchanges are partitioned before using
lossy emergency previews; an indivisible oversized exchange may still need an
archived preview or fail closed. Model, reasoning strength and output allowance
remain those of the conversation.

Inherited checkpoints are explicitly indexed as conversation memory, including
the earlier requirements and outcomes they carry, rather than only their carrier
Turn's pause/acknowledgment. If all historical sources are summary projections and
the active Turn fits the recent-content allowance, Runtime selects the oldest
approximately two thirds by serialized input volume, aligned to complete source
boundaries, and requests one model-authored merged memory. The recent portion is
kept verbatim. Source ranges, transitive coverage and the merge marker are durable;
there is no local semantic ranking, keyword correctness test or silent deletion.
Age follows the earliest inherited Turn, not the later checkpoint carrier. If
selected sources are separated by retained recent Turns, only their exact ranges
enter the merged source; complete-exchange partitions preserve those gaps on
restart. A single merged summary stays in its original Tool call and the receipt
references that field, avoiding a duplicate copy of the same memory.

Merged receipts include a `conversation-history://turns/first/last` locator. The
deferred `read_conversation_history` tool reads bounded, revision-checked NDJSON
pages from the current Session's existing journal, including user corrections and
final replies. It omits hidden provider reasoning/replay and image payloads,
marks superseded records, and does not grant filesystem or cross-Session access.
Relative Turn locators remain usable in forks. Semantic relevance and fidelity
remain the model's responsibility; Runtime validates identities, bounds and the
complete rebuilt request budget before committing any replacement.
The preferred target leaves up to 20% (capped at 16k tokens) below the trigger.
After bounded refinement, a candidate can still be accepted if it leaves at least
half that headroom, reduces the previous input, fits the hard token cap and stays
below the transport warning. The completion event records this admission target;
missing an ideal target by a few tokens is not an unusable conversation.

The committed checkpoint references a real model call and Tool receipt carrying
the accepted texts. Runtime keeps the original user input and continues the same
Tool loop without replaying completed side effects. Original assistant and Tool
messages remain in the append-only journal; there is no unrecorded fallback that
silently drops older summaries. All three API adapters use a default JSON-body
budget of 40,000,000 bytes, with maintenance starting at 35,000,000 bytes.
`maxRequestBodyBytes` can override the default for a known transport limit.
See [image and request budgets](../../docs/MODEL_IMAGE_BUDGET.md).

Every completed Tool round receives one aggregate context-ingress budget derived from
the latest measured input, actual model output and checkpoint reserve. Parallel Tool
results share that budget rather than each receiving an independent 16,000-character
allowance. Exact native results remain in `ToolExecutionStore`; only their model
projection is shortened, with a durable `tool-result://` locator. Image follow-ups
consume the same budget. This keeps the following checkpoint request inside the
configured context window even when one parallel batch returns many large results.
An already-oversized legacy Session has a request-only recovery projection which
shortens large archived results before staging complete source fragments. Assistant
reasoning, provider-owned replay and all parallel receipts remain intact; the
append-only Session and Tool journals are never rewritten.

Runtime emits a durable context-compaction lifecycle (started, retrying,
completed, failed or cancelled) with one stable compaction identity. These are
maintenance facts rather than model messages or Tool execution records: the
desktop may render them with the familiar Tool-row treatment, but they never
enter model context, Workspace Change review/revert, or ordinary Tool activity
counts. Summary text remains in the context-checkpoint store and is not copied
into presentation events.

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

Archive pagination is finalized against the actual delivery budget, including
the shared per-round budget. `next_offset` advances only past delivered text or
whole search hits; a cropped page stays incomplete and keeps the original
locator. MCP batch loading uses the same budget and defers entire schemas that
do not fit, so only delivered complete definitions become callable.

Execution-history search retains bounded structured task IDs and local output
paths separately from prose summaries. Exact reference matches outrank generic
tool-name matches. Archive-reader calls remain in the journal but are excluded
from the search index to avoid indexing repeated retrieval of the same result.

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
exactly that requested capability set. Cached Session grants bind each capability
ID to the approved actions and target kinds/values. Reusing a tool-owned ID for
another target cannot reuse that grant; native capability IDs and Tool returns
are not rewritten.

`all_free` is enforced once by the Tool execution coordinator, including nested
Tools and child Agent Turns. Tool-owned `deny` decisions remain final; every
ordinary `ask` is granted without publishing a permission interaction to the UI.

Runtime does not infer task semantics or rewrite terminal commands. It applies one
deterministic hard-safety exception: direct shell deletion of a filesystem root,
the user home, a sibling of the user home, or a project/workspace root is denied
before execution and cannot be approved. `terminal_exec`
returns completed output and exit status when the command finishes inside its
declared yield window; otherwise it returns `state=running` with a stable
terminal session handle. `terminal_poll`, `terminal_write`, `terminal_list`, and
`terminal_stop` manage that handle without blocking the Agent
Loop. Cancelling a wait does not implicitly stop the spawned terminal session.
This workspace permission protocol controls declared paths and the terminal
working directory. When command isolation is enabled, AppContainer/bubblewrap
separately enforce the OS access boundary; the workspace permission protocol
alone does not constrain paths a command may access.

Terminal receipts retain the requested cwd, active sandbox scopes, native error
codes and the supervisor's `commandStarted` fact. A pre-start refusal has no
command exit code; its supervisor status is recorded separately. PowerShell
initializes its provider location from the process cwd and fails instead of
silently continuing from another directory. Its typed ErrorRecords provide
bounded, explicitly interpreter-reported diagnostics even when ordinary stderr
was suppressed. Such records do not prove that no partial effects occurred.
Exit 1 or localized error text alone never establishes a permission denial.
The final model projection retains denial classification and sandbox status
even when the full output must be archived.

On Windows, PowerShell uses a provider drive rooted at the admitted cwd when
normal drive initialization cannot reach it. The diagnostic wrapper preserves
that provider location instead of re-entering the absolute path. Parent metadata
and directory listing remain outside the admitted roots; no ancestor ACL grants
are added for cwd initialization. Use `(Get-Location).ProviderPath` when passing
the physical working directory to native commands.

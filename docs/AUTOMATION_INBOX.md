# Scheduled-task inbox

CardBush's existing runtime scheduler owns both plans and execution results. The app must be running. There is no separate service; missed intervals coalesce into one execution when the runtime resumes.

## Results and acknowledgment

Each run has a stable run ID, turn ID and execution session ID. Terminal runs start unread, including failed, interrupted and permission-blocked runs. Opening a result, querying it with `scheduled_results`, or continuing its conversation does not mark it read. The user can mark individual results read or unread, or acknowledge the currently displayed results in a batch.

Read commands identify exact run IDs, validate the whole batch, and update only `readAt`. They do not change plan state, execution state, next execution time or the plan's edit revision. Newly arriving results cannot be swept into an in-flight batch. At most 50 acknowledged historical runs are retained per plan; unacknowledged results are not expired by that cap.

The results page provides Unread, Today and All results views with local date groups, and a separate Plans management view. The sidebar displays the unread count. Existing plan controls and conversational creation remain available.

## Execution conversations

Time-based plans execute in separate temporary conversations. Creating or explicitly saving a plan snapshots its model, tool allowlist, generation options, workspace and permissions in the scheduler's private `jobContexts`. Ordinary source turns do not change that configuration. No source chat history or response-chain state is copied, so the saved prompt must contain the complete task requirements. Deleting the source leaves the timer and its settings intact; it can still be edited, run, paused or resumed. Source navigation is available only while that session exists, as checked against the runtime session store.

Each temporary execution persists its ordinary conversation journal for results and follow-ups, with `hidden: true` keeping it out of Recent. It is not erased on completion. Opening the result inspector keeps it hidden; explicitly opening the full execution conversation promotes the same session to Recent. The inspector and plan details keep a separate link back to the source. Deleting a conversation requires user confirmation and explains the effect on scheduled tasks.

Existing clock plans migrate future runs and snapshot their last saved source configuration once. Completed/running run identities, unread status and manually paused plans stay unchanged. An interrupted run is still paused rather than replayed. Missing legacy settings are reported as an explicit failure, never reconstructed from chat semantics. Old prompts are not rewritten; prompts that rely on prior discussion need their requirements filled in. Event-triggered plans and trusted plugin wakeups remain tied to source events, so source deletion pauses them and cancels queued wakeups. Event plans can still choose a separate execution conversation.

The inspector renders the actual execution session with the shared message renderer. Follow-up messages use the normal runtime turn path with the saved model, workspace, permissions and tool restrictions. Closing or hiding the inspector does not cancel a follow-up. Reopening observes the same turn; stopping requires the explicit stop button. A missing execution session cannot be silently recreated by the inspector.

## Context reminders

Before preparing a genuine user turn, the runtime reads a fresh unread snapshot. It stores the snapshot in metadata on the user message so the UI can show what was attached at send time. A compact internal user-role message follows the authored input in the model request. It contains the total unread count and up to eight recent titles, states, timestamps and stable IDs. The `scheduled_results` tool provides details and paginated access on demand without acknowledging anything.

The reminder labels itself as an observation at its recorded `asOf` time and treats titles/results as data rather than new instructions. It does not modify the user's text. Once sent, its exact internal message is retained in the same conversation journal and recovery checkpoint as other inputs; the UI hides this internal message and can show the existing attachment badge on the authored message. Scheduled wakeups, child turns and goal continuations preserve earlier observations without adding reminders.

User guidance sent during a running turn also carries a fresh snapshot. Changed state is appended after the guidance, including a zero-count snapshot when the inbox becomes empty. Earlier messages are never filtered out or replaced. An unchanged snapshot is not injected again merely because `asOf` advanced. Deduplication compares with the latest actual reminder still visible in the current model context; after compaction removes that observation, a fresh nonempty snapshot can be appended. The scheduler remains the sole owner of inbox state; the journal records what was sent, without a second reminder state store.

## Request continuity

Automation launches retain the source conversation's tool order while refreshing definitions and availability from the authoritative registry. Trigger metadata is appended as committed turn input, using the saved run ID and activation time, rather than inserted into the system/developer prefix. Retries and recovery reuse the original observation. The saved context uses the protocol's shared generation options, including `temperature` and `topP`, without persisting transient response-chain state or input messages.

Cache diagnostics compare message prefixes independently of changed parameters. `breakIndex` still reports the overall earliest boundary; `messageBreakIndex` reports a separate message rewrite even when tools or other parameters also changed. Actual schema changes and applied compaction remain observable breaks. Existing journals are not backfilled with messages that were never committed; switching from older request assembly can cause an initial boundary change.

## Verification

`npm run test:automations` covers scheduling, migration, persistence, acknowledgment races, unread retention, real Electron worker execution and follow-ups, results UI, and inspector close/reconnect behavior. It also compares full provider inputs across ordinary/automatic/repeated turns, unread changes, guidance and recovery with a nonempty tool catalog and explicit generation options. UI fixtures use isolated temporary profiles and a fixture model; they do not execute the user's real scheduled tasks.

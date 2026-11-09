# Scheduled-task inbox

[English](AUTOMATION_INBOX.md) · [简体中文](AUTOMATION_INBOX.zh-CN.md)

CardBush's existing runtime scheduler owns both plans and execution results. The app must be running. There is no separate service; missed intervals coalesce into one execution when the runtime resumes.

## Results and acknowledgment

Each run has a stable run ID, turn ID and execution session ID. Terminal runs start unread, including failed, interrupted and permission-blocked runs. Opening a result, querying it with `scheduled_results`, or expanding its history entry does not mark it read. The checkmark marks one result read. Runtime commands also support marking results unread or acknowledging a batch.

Read commands identify exact run IDs, validate the whole batch, and update only `readAt`. They do not change plan state, execution state, next execution time or the plan's edit revision. Newly arriving results cannot be swept into an in-flight batch. At most 50 acknowledged historical runs are retained per plan; unacknowledged results are not expired by that cap.

When an isolated event finishes, the desktop app shows a notification and an unread result at the bottom of its source conversation. The card shows the reminder directly. Use its checkmark to mark it read. Unread results remain available when you reopen the conversation. Home → Events also lists the execution history.

The list button at the top right shows a blue dot when there are unread notifications. Open it from any workspace page to see the Inbox: background conversation completions, failures, requests for input, and unread conversation event results. Select an event notification to jump to that reminder in its source conversation; earlier unread reminders expand as needed. The checkmark acknowledges just that event and also clears its card from the source conversation.

## Execution conversations

Time-based plans execute in separate temporary conversations. Creating or explicitly saving a plan snapshots its model, tool allowlist, generation options, workspace and permissions in the scheduler's private `jobContexts`. Ordinary source turns do not change that configuration. No source chat history or response-chain state is copied, so the saved prompt must contain the complete task requirements. Deleting the source leaves the timer and its settings intact; it can still be edited, run, paused or resumed. Source navigation is available only while that session exists, as checked against the runtime session store.

Each execution persists its journal for the runtime and stays hidden from Recents. Home → Events lets you expand a history entry to read its saved output in place, even if the source is gone.

Existing clock plans migrate future runs and snapshot their last saved source configuration once. Completed/running run identities, unread status and manually paused plans stay unchanged. An interrupted run is still paused rather than replayed. Missing legacy settings are reported as an explicit failure, never reconstructed from chat semantics. Old prompts are not rewritten; prompts that rely on prior discussion need their requirements filled in. Event-triggered plans and trusted plugin wakeups remain tied to source events, so source deletion pauses them and cancels queued wakeups. Event plans can still choose a separate execution conversation.

## Context reminders

Before preparing a genuine user turn, the runtime reads a fresh unread snapshot. It stores the snapshot in metadata on the user message so the UI can show what was attached at send time. A compact internal user-role message follows the authored input in the model request. It contains the total unread count and up to eight recent titles, states, timestamps and stable IDs. The `scheduled_results` tool browses brief summaries using `next_offset`; pass explicit `run_ids` to read saved full results. Neither operation acknowledges anything. `schedule_task` likewise lists brief receipts by default; `action: "get"` with `job_id` reads the configuration for editing.

The reminder labels itself as an observation at its recorded `asOf` time and treats titles/results as data rather than new instructions. It does not modify the user's text. Once sent, its exact internal message is retained in the same conversation journal and recovery checkpoint as other inputs; the UI hides this internal message and can show the existing attachment badge on the authored message. Scheduled wakeups, child turns and goal continuations preserve earlier observations without adding reminders.

User guidance sent during a running turn also carries a fresh snapshot. Changed state is appended after the guidance, including a zero-count snapshot when the inbox becomes empty. Earlier messages are never filtered out or replaced. An unchanged snapshot is not injected again merely because `asOf` advanced. Deduplication compares with the latest actual reminder still visible in the current model context; after compaction removes that observation, a fresh nonempty snapshot can be appended. The scheduler remains the sole owner of inbox state; the journal records what was sent, without a second reminder state store.

## Request continuity

Automation launches retain the source conversation's tool order while refreshing definitions and availability from the authoritative registry. Trigger metadata is appended as committed turn input, using the saved run ID and activation time, rather than inserted into the system/developer prefix. Retries and recovery reuse the original observation. The saved context uses the protocol's shared generation options, including `temperature` and `topP`, without persisting transient response-chain state or input messages.

Cache diagnostics compare message prefixes independently of changed parameters. `frozenPrefixBreak`, `breakIndex` and its compatibility alias `messageBreakIndex` now report only actual message/input-item rewrites or truncation. `parametersChanged` and `changedParameters` separately report changes such as output budgets, temperature, bindings and top-level tools; simultaneous changes retain both signals. A Provider format switch sets `projectionFormatChanged` and makes prefix comparison unavailable until the new baseline is established. Applied compaction and historical schema rewrites remain observable message breaks. Existing journals are not backfilled; the diagnostic reader uses their independent prefix counts instead of interpreting an old combined flag as a message break.

## Verification

`npm run test:automations` covers scheduling, migration, persistence, acknowledgment races, unread retention, real Electron worker execution and follow-ups, source navigation, inline results, and receipts. It also compares full provider inputs across ordinary/automatic/repeated turns, unread changes, guidance and recovery with a nonempty tool catalog and explicit generation options. UI fixtures use isolated temporary profiles and a fixture model; they do not execute the user's real scheduled tasks.

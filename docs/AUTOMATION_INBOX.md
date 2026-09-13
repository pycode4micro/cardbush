# Scheduled-task inbox

CardBush's existing runtime scheduler owns both plans and execution results. The app must be running. There is no separate service; missed intervals coalesce into one execution when the runtime resumes.

## Results and acknowledgment

Each run has a stable run ID, turn ID and execution session ID. Terminal runs start unread, including failed, interrupted and permission-blocked runs. Opening a result, querying it with `scheduled_results`, or continuing its conversation does not mark it read. The user can mark individual results read or unread, or acknowledge the currently displayed results in a batch.

Read commands identify exact run IDs, validate the whole batch, and update only `readAt`. They do not change plan state, execution state, next execution time or the plan's edit revision. Newly arriving results cannot be swept into an in-flight batch. At most 50 acknowledged historical runs are retained per plan; unacknowledged results are not expired by that cap.

The results page provides Unread, Today and All results views with local date groups, and a separate Plans management view. The sidebar displays the unread count. Existing plan controls and conversational creation remain available.

## Execution conversations

New time-based plans default to a separate persistent conversation for each run. The plan's source supplies the latest model, tool allowlist, workspace and permissions. Event-triggered plans default to continuing their source conversation. Old saved plans without an execution mode keep that original behavior. Editing a plan can select either mode.

The inspector renders the actual execution session with the shared message renderer. Follow-up messages use the normal runtime turn path with the saved model, workspace, permissions and tool restrictions. Closing or hiding the inspector does not cancel a follow-up. Reopening observes the same turn; stopping requires the explicit stop button. Full conversation access is also available from the inspector.

## Context reminders

Before preparing a genuine user turn, the runtime reads a fresh unread snapshot. It stores the snapshot in metadata on the user message so the UI can show what was attached at send time. A compact internal user-role message follows the authored input in the model request. It contains the total unread count and up to eight recent titles, states, timestamps and stable IDs. The `scheduled_results` tool provides details and paginated access on demand without acknowledging anything.

The reminder labels itself as app context and treats titles/results as data rather than new instructions. It does not modify the user's text or persist as another conversation message, so obsolete reminders do not accumulate in later model context. Scheduled wakeups, child turns and goal continuations do not inject reminders. The next user message reflects any read-state changes.

User guidance sent during a running turn also carries a fresh snapshot. When that guidance is applied, its snapshot replaces the earlier model-only reminder. Marking results read during execution therefore does not leave the agent working from an obsolete unread count.

## Verification

`npm run test:automations` covers scheduling, migration, persistence, acknowledgment races, unread retention, real Electron worker execution and follow-ups, results UI, and inspector close/reconnect behavior. UI fixtures use isolated temporary profiles and a fixture model; they do not execute the user's real scheduled tasks.

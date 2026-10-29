# Context, compression and personal memory

[English](CONTEXT_AND_MEMORY.md) · [简体中文](CONTEXT_AND_MEMORY.zh-CN.md)

These are separate mechanisms. Conversation history records what happened; context compression projects a smaller input for the same task; habit memory and predictions optionally personalize future work. Compression does not automatically turn a conversation into a cross-session habit.

## Ordinary turns and pressure

Runtime persists user inputs, assistant text, tool calls/results and terminal states. Ending a turn does not immediately rewrite history or make a summary model request. A standalone `summary_for_user` after tool work is a final-display signal with optional gated personalization fields; an empty object is valid and it is not a compaction call.

When the input approaches its budget, the default path derives a handoff from completed turns: tool name, recorded reason/title, relevant parameters, observed result and exact final reply. It retains corrections in order, failures, unfinished/unknown states, identifiers and permission facts. A returned tool is not automatically labeled successful. Known large text can use explicitly marked excerpts with archive locators; source instructions and image exchanges retain their stricter handling.

Runtime accepts this projection only if the complete rebuilt request shrinks and fits token/output reserves and body limits. Original history is still available for audit, fork and tool inspection. Applied references/digests persist across restart without repeating effects. `preferRecordedToolHandoffs:false` exists for controlled comparisons, not as a new UI workflow.

## Model fallback

If recorded compression cannot create enough room, Runtime asks the same model for `checkpoint_context`; it is not a model-initiated proactive tool. Sources have stable numbers. Valid partial entries are retained, all required sources must finish, and oversized sources partition at complete message/tool-exchange boundaries before consolidation. Real input, accepted summaries and source links remain traceable.

Older summary-only history may be consolidated, retaining recent complete sources. The full continuation request is validated before a checkpoint is committed/completed, with bounded refinement and usable headroom. Maintenance rounds do not consume the bounded task-round budget of message wakeups. Restart retains accepted work and fragment boundaries rather than starting over or repeating tools.

The model's semantic fidelity still needs review. Source paths/revisions/lines establish provenance, not proof that every requirement survived paraphrasing. `read_conversation_history` reads bounded pages from the current session's original journal; `read_archived_tool_result` accepts exact Runtime-issued locators. Neither is unrestricted cross-session/file access.

Default context configuration is 530000 tokens, but configure the actual provider/model limit. A larger configured window does not create provider capacity. Output reserves and wire-body size are separate: adapters default to 40,000,000 JSON bytes, with maintenance at 35,000,000. Tool results in a parallel round share a single ingress budget, including images, rather than each filling the entire remaining context. See [image budgets](MODEL_IMAGE_BUDGET.en.md) and the [Runtime contract](../packages/bush-runtime/README.md).

## Cache diagnostics

Parameters changing and actual message-prefix rewrites are separate. `parametersChanged/changedParameters` identify budgets, temperature, tools or binding changes; `frozenPrefixBreak/breakIndex/messageBreakIndex` identify real input changes. Projection format changes establish a new baseline. Applied compression can cause a real break once; ordinary append-only turns should not be called broken merely for a parameter change. Only provider-reported usage proves cache hits. See [cache routing](PROMPT_CACHE_ROUTING.en.md).

## Optional personal memory

Habit and prediction switches are independent and default off in new sessions. CLI `/habit` and `/prediction` operate on that session, persist on resume, and are inherited independently by a fork. Turning them off does not delete existing records. Recall filters expired/withdrawn/superseded entries and does not harvest later user messages into an evidence queue automatically.

Ordinary completion coalesces local deduplication, expiry and undoable evidence archival; it makes no automatic summarization model call at token thresholds. Recallable memory and evidence each have an 8,000-active-record protection limit. Long-lived habits do not expire merely because they were not recalled recently; predictions normally expire after seven days.

Manual model organization is explicit and incurs usage. It uses the existing internal task runner with bounded inputs/retries/cancel, validates source quotes and records partial valid results. Unknown evidence does not become a contradiction, failed work does not trigger another automatic background job, and original provenance remains. See [memory maintenance](memory-maintenance.en.md) for capacity, recovery and isolated replay.

Assistant conversation summaries and voice restoration are another bounded conversation projection, not the habit database; see [assistant](PERSONAL_ASSISTANT.en.md) and [voice](REALTIME_VOICE.en.md). In diagnostics, keep token accounting, structural continuity and result quality separate, and do not share private raw history without redaction.

# Background MCP waits and subagent continuation

[English](ASYNC_TOOL_AND_SUBAGENT_CONTINUATION.en.md) · [简体中文](ASYNC_TOOL_AND_SUBAGENT_CONTINUATION.md)

[中文](ASYNC_TOOL_AND_SUBAGENT_CONTINUATION.en.md) | [Documentation](README.md)

This is a CardBush host capability. Plugins provide ordinary MCP tools; they need no knowledge of CardBush sessions, parent/child ownership or reverse wakeup protocols.

## Background tools

Load the complete target schema with `get_tool_schema`, then call `start_mcp_tool` with `name`, original `arguments` and bounded `max_wait_ms`. Optional `repeat_while`:

```json
{ "path": ["structuredContent", "status"], "equals": "timeout" }
```

The condition must come from the tool's declared result structure. The host repeats only on an exact path/value match, without asking the model, retrying errors or altering arguments. The default budget is five minutes, maximum one hour. Only MCP tools declaring `readOnlyHint=true` are accepted. This hint grants no permission: each call still checks discovery, the current definition, child restrictions, approvals, Hooks and original timeouts. A definition change stops repetition.

Startup immediately returns `task_id`. The model may continue independent work. `tasks` supports `list`, `inspect`, `wait`, `stop` and `cancel_observation`, with optional `task_ids` and `mode=any|all`. An internal `background_tool_result` delivers a result once at the next model boundary, retaining external-data trust. Each execution remains in the journal. Cancelling one observer does not affect other tasks; stopping a Turn cancels that Turn's background calls.

If the model tries to finish while background tools/subagents remain, the host suspends until the first result and resumes the model. This extends an already active Turn; it creates no new conversation or automation and replays no background operation after restart.

## Terminal completion

`terminal_exec` defaults to `notify_on_exit=true`. A foreground wait remains limited to 30 seconds. A still-running command returns `terminalSessionId`, `completion_notification=true` and `completion_task_id`. This is not an execution timeout; do not restart the command.

Continue independent work, then use `tasks` with `action=wait` and `task_ids=[completion_task_id]`. A wait without IDs selects only unfinished tasks, preventing old results from causing empty polling loops. The host also waits for pending notifications when the model tries to finish.

Local/cloud Agents observe real process exit and output-stream closure in their Runtime. Direct SSH uses its private bridge to observe the remote channel with bounded host waits. This neither polls the model, reruns commands nor consumes manual-poll output. Notification contains the real exit code, a short log and full-log archive reference, delivered once in the original active Turn. It appends to context/journal rather than overwriting the launch receipt or adding another tool call on history reopening.

Stopping the Turn/cancelling notification detaches observation without killing the process. Use `terminal_stop` to terminate it. Set `notify_on_exit=false` for persistent services or interactive processes. Observation lasts at most one hour; expiry reports that the process is still running without inventing success or killing it. Restart does not restore/replay commands.

## Subagent continuation

Pass this to `subagent`:

```json
{ "prompt": "Continue with the follow-up issue", "task_id": "previously-returned-taskId" }
```

A running task receives guidance and returns `message_queued` without duplicate dispatch. A finished task gets a new task/Turn in the same child session. Its history, original prefix, model and execution host remain. Tools/permissions are the intersection of the original configuration and current host restrictions; concurrent continuation of one child session is rejected. Only the owning parent can continue ordinary children; Team owns its nodes. A changed parent workspace cannot implicitly move an old child.

Original execution configuration is persisted under `subagent-context` and combines with session persistence for restart continuation. This works only for tasks with saved configuration; older finished tasks without it fail explicitly rather than guessing permissions/history. Retain returned task IDs. Plugin chat credentials remain in each Agent's own context.

`tasks action=wait` supports `mode=any|all`, defaulting to any. Work may continue after the first needed result while siblings keep running. Explicitly selecting a completed task retrieves its result again.

The text assistant uses shared Runtime `tasks`. Realtime voice's `tasks action=inspect` returns status and registers asynchronous notifications without blocking speech. `tasks action=conversation` pages through completed conversations and only reads records. Discover plugin roles through `list_subagent_options.agent_roles`; `tasks` manages cross-Turn background listing, waiting and stopping.

## Verification

`backgroundToolCalls.test.mjs` covers independent work, model-free repeated waits, cancellation, Turn isolation, permissions and Hooks. `subagentResume.test.mjs` covers rebuilt-host context/model preservation, ownership, concurrent-continuation rejection and any-mode waits.

# Built-in tool execution

The registry remains the authoritative capability catalog. Provider definitions are a presentation of that catalog, not a permission grant. Every nested invocation still passes through `ToolExecutionCoordinator`, including scope, child policy, MCP discovery, authorization, hooks, result validation and the execution journal.

## Default interfaces

| Need | Interface |
| --- | --- |
| Run a command / send stdin | `terminal_exec` / `terminal_write` |
| Read exact files / simple edits | `read_file` / `edit_file` / `write_file` |
| Related local text changes | `apply_patch` |
| Observe terminal, child, Team, MCP, question or script tasks | `tasks` |
| Ask while continuing independent work | `request_user_input_async` |
| Filter, transform or chain tool results | `run_tools` |
| Load configuration parameters | `get_tool_schema` |

`subagent` and `team` expose common run/query parameters by default. Plugin roles (`agent_type`) remain directly usable. When `tasks` is available, Team exposes `list/get/run/resume`; load its full schema for editing definitions or reading selected node outputs with `wait.node_ids`. Definitions shrink again when the full schema receipt leaves the visible context. The legacy `parallel_tools`, `manage_tool_calls`, `manage_plugin_agents`, `await_subagents` and `solution_selection` interfaces remain callable for compatibility; their replacements are presented by default, and `get_tool_schema` can reveal them explicitly. A scoped catalog without the replacement or schema loader retains the legacy interface. The authoritative request scope is never broadened by loading a schema.

The default catalog stays stable rather than guessing a tool subset from each user message. Small low-frequency tools and `update_task_plan` stay available. This adds no built-in tool search. Empty installed Command catalogs hide `list_plugin_commands` and `run_plugin_command` in provider presentation only; Skills remain available. Current installation state is refreshed between model rounds, including after restart. Unknown state does not imply an empty catalog. Native handlers and request scopes remain intact for saved calls, explicit commands and hooks. Child execution policy stays in admission, preserving a fork's shared tool prefix.

## Definition diagnostics

Each `cache_chain_observed` event includes `payload.toolDefinitions` for the actual projected tools sent in that model request. It records counts, serialized JSON character sizes, top-level description and input-schema character sizes, built-in counts/sizes excluding MCP/native extensions, and the five largest definitions by name and size. No descriptions, schemas or user content are copied into diagnostics, and diagnostics are not injected into model messages.

`estimatedTokens` uses `runtime-tool-json-chars-v1` (JSON characters divided by four, rounded up; zero for no tools). This is a local comparison estimate, not provider token usage or billing. Character counts measure Runtime definitions, including UI title fields; provider wire formatting may differ. Use the existing request-usage events for provider-reported totals. Evaluate savings together with extra model requests and task outcomes, not tool count alone.

## Tasks and questions

Start receipts retain their existing handles. Team and asynchronous tools also provide `task_id`; terminals accept their session ID or completion-notification ID in `tasks`. Subagents retain `taskId`, usable unchanged as an entry in `task_ids`.

`tasks` supports `list`, `inspect`, `wait`, `stop` and `cancel_observation`. Lists are bounded, show pending work first and omit results. `after` carries per-task revisions and suppresses unchanged result bodies. An unavailable source is explicitly reported without hiding independent tasks from other sources; status reads have a one-second per-source timeout.

Waits default to 1 second, allow snapshots at 0, and cannot exceed 30 seconds. They wake on any/all completion or user guidance. Wait cancellation and timeout leave executors running. `cancel_observation` removes only a completion subscription; terminal status continues to come from the process. `stop` uses the executor's cancellation path, including ordinary terminal-stop permissions. Unsupported controls are explicit, including remote children whose bridge has no stop capability.

Questions use the existing persistent-in-turn UI broker. They return immediately and share task observation and automatic result delivery. Only an actual selected answer resolves a dependency; dismissal or turn cancellation grants no approval. One question may be pending per conversation. Question text allows 500 Unicode characters, suggested answers 120 each.

Plan nodes keep `status=waiting` with a concrete `waitingFor` and a `waitingKind`: `user` for confirmation/input, `background` for an already-started task, or `dependency` for a prerequisite step. The terminal and committed turn retain this classification for streaming, recovery and history. Only user waits trigger attention notifications; passive waits use a neutral status. Older unclassified waits remain readable as generic waiting, without inferring user action from prose. Patches clear wait fields on resume/completion; changing the reason without a category clears the old category. Multiple waits prioritize explicit user input, and a pending interactive question cannot be hidden by a passive plan state. Plan updates still do not force another model response.

## Scheduling and recovery

`manifest.mutating`, `parallelSafe`, `resources` and `nestedCallable` have separate meanings. Read-only batching requires all relevant checks, not just `parallelSafe`. Normal tool rounds group adjacent safe calls, preserving barriers around unsafe calls. File operations acquire canonical-path read/write leases; independent paths and readers may proceed concurrently. Remote file writes conservatively coordinate per connection until that host supplies canonical resource identities. Terminal output consumers coordinate per handle. Cancelling an observer does not release the lease of an executor that is still running.

Execution records and error projections carry `execution` facts:

- `dispatch`: not started, handler started, or returned.
- `effects`: none, possible, or recorded workspace changes. `possible` deliberately does not claim a write occurred.
- `result`: known or unknown.
- `recovery`: none, retry, correct input, inspect existing work, or do not retry.

Delegating calls retain nested effect and permission evidence. Uncertain mutations require inspection regardless of an HTTP status. No generic automatic replay is added. Native results and full change evidence remain in the existing archive; failures present recovery information before long output.

Executors can attach verified failure facts with the internal `withToolFailureFacts` helper. The coordinator reads an in-process association, never an error's text or serialized `details.execution`. Recorded changes and nested uncertainty take precedence. A patch rejected during preflight reports `effects=none`, `result=known`, `recovery=correct_input`; attempts that reached a write remain conservative, including after rollback. Cancellation still reports that observation stopped without proving the executor stopped.

## MCP management observations

The app's `list_mcp_servers` and `list_plugin_connections` tools default to a compact `view=summary`: configuration identities/revisions, connection health, errors, pending state and `toolCount`. They omit bulk tool-name arrays and plugin editing settings. `serverId` filters one exact service across configuration, connections and Runtime state; `matched=false` means it was absent from that observation, not that an unavailable Runtime was checked successfully. Disabled saved entries remain visible even without a live service. Runtime errors and `runtime=null` are preserved.

Use `detail=true`, preferably with `serverId` (or `pluginId` for plugin connections), for complete tool names and the existing credential-safe connection settings. Global application progress/revisions remain global; service `updateState` describes the selected service. Summary projections do not claim to be the full native MCP snapshot protocol. UI, host observations, execution permissions and connection lifecycle use their existing full data; only the model-facing read-tool results are projected.

## Multi-file patch

`apply_patch` accepts the `*** Begin Patch` / `*** End Patch` format, Add/Update/Delete files, optional Move to, and exact `@@` contexts. Existing revisions must have been read. The runtime authorizes all paths, validates all changes before writing, locks every target and preserves review/undo evidence. Ambiguous hunks and duplicate paths fail before mutation. A later I/O failure attempts rollback; any remaining changes retain evidence and are reported explicitly. This is a preflighted batch with compensation, not a cross-filesystem atomic transaction. Limits: 64 files, 2 MiB patch text, 32 MiB staged before/after data, and the existing 8 MiB per-file limit. SSH continues using its routed individual file tools.

## Tool scripts

`run_tools` executes an async JavaScript function body in a separate QuickJS/WASM heap. It provides `tools.NAME(args)` and `tools.call(name, args)`, JSON data and JavaScript transforms. It exposes no Node, filesystem, network, timer or import APIs. Example:

```js
const file = await tools.read_file({ path: 'records.json' });
return JSON.parse(file.content).sort((a, b) => b.sales - a.sales).slice(0, 10);
```

Scripts start as turn-owned background tasks, so awaiting a tool inside the script does not suspend the model's next independent step. Each nested call has its own ordinary journal record. Safe calls may run concurrently; unsafe calls in one channel remain ordered. Await dependent writes explicitly.

Budgets: 64,000 code characters, 32 calls, 8 calls in flight, 32 MiB guest memory, 1 second total guest CPU with 250 ms slices, 5 minutes wall time, and 2 MiB final serialized data. Unawaited tool operations are drained before successful completion. Failure or cancellation may leave completed effects; review their existing records before rerunning. Hooks can stop the parent turn even when a nested call completes after the initial script handle was returned.

Regression coverage is in `packages/bush-runtime/test/unifiedToolSystem.test.mjs` and `builtinToolDisclosure.test.mjs`, with existing task, journal, permissions, Team, workspace, MCP and model-loop tests retained.

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
| Invoke a loaded native definition | `call_tool` |

`subagent` and `team` expose common run/query parameters by default. Plugin roles (`agent_type`) remain directly usable. When `tasks` is available, Team exposes `list/get/run/resume`. For editing definitions or reading selected node outputs with `wait.node_ids`, load the full schema with `get_tool_schema`, then use `call_tool({name, arguments})`. The complete schema stays in the tool result; loading or compacting it never expands or shrinks the top-level definitions. A current, complete schema receipt must remain in context for `call_tool`; a missing, stale or partially read receipt requires reloading. Loading a schema never broadens the authoritative request scope.

`call_tool` transparently enters the existing coordinator under the selected native name. Native validation, permissions, hooks, resource locks, scheduling, cancellation, results and UI/journal activity are reused; the wire call/result keeps its original ID. It is not another background executor or nested script. Discovery, archive reads and context-maintenance entry points remain direct calls so their history receipts retain their meaning. The legacy `parallel_tools`, `manage_tool_calls`, `manage_plugin_agents`, `await_subagents` and `solution_selection` interfaces remain callable for compatibility; replacements are presented by default and their full definitions can be loaded for `call_tool`. A scoped catalog without the replacement, schema loader or invocation gateway retains the legacy interface.

Schema discovery and invocation are separate checks. `get_tool_schema` also describes direct entry points (including `mcp_call`) and returns their actual invocation route; this does not make recursive `call_tool` wrapping legal. MCP load receipts carry the `mcp_call` argument envelope, preserved through bounded delivery. Permissions, schema-delivery prerequisites and provider declarations remain unchanged.

Rejected native/MCP routes return `corrected_call` with the original target arguments. Repeated identical route failures derive a targeted entry-point schema check from the existing conversation receipts and omit repeated full definitions. These are suggested next actions, never automatic forwarding or replay. Unknown aliases are not guessed, and corrected calls still require current discovery, scope, permission and Hook checks.

The default catalog stays stable rather than guessing a tool subset from each user message. Small low-frequency tools and `update_task_plan` stay available. This adds no built-in tool search. Empty installed Command catalogs hide `list_plugin_commands` and `run_plugin_command` in the initial provider presentation only; Skills remain available. The final projected catalog is frozen for the turn. Installation changes refresh execution scope and append catalog notices, without changing that snapshot: use `get_tool_schema`/`call_tool` for added or revised native extensions and `mcp_search`/`mcp_call` for MCP. Removed tools remain unavailable. Unknown state does not imply an empty catalog. Native handlers and request scopes remain intact for saved calls, explicit commands and hooks. Child execution policy stays in admission, preserving a fork's shared tool prefix.

Normal MCP recall, repeated loads, Skill reads and progressive result pages append results without replacing provider declarations. A real MCP schema revision in Responses native discovery still requires its existing one-time full replay to avoid duplicate conflicting declarations; this is distinct from recalling an unchanged schema. Explicit tool/model/system changes or context compaction can also invalidate an older Anthropic thinking signature. The adapter records the projected prefix with new replay data, omits incompatible thinking blocks while preserving text/tool results, and permits one repair only after an explicit legacy prefix-binding rejection. Durable history is unchanged, and ordinary 400 errors do not trigger that repair.

## Stable policy and instruction ownership

The fixed system policy owns cross-tool behavior: user-language and style scope, authorization, independent work while waiting, verification, delivery, and the timing of the final-display signal. Tool descriptions own invocation constraints, parameter meanings and result semantics. Keep those details on the existing tool contract rather than repeating another tool manual in the system policy. `summary_for_user` remains available: after tool work, the model signals the final response before its first text delta; optional memory fields and their validation belong to the tool. The host does not infer completion or force an extra model round.

Prompt cleanup is a versioned change for new product conversations, not per-turn loading. On first dispatch the existing session journal binds one `model_contract_bound` fact containing the system message and provider-facing definitions. Continuing, restarting and forking reuse that presentation. The contract is omitted from sidebar summaries and history pages. Live request scopes, permissions and tool handlers still authorize every call; frozen definitions never grant removed capabilities. Internal tasks retain their own assembly. Context maintenance uses the advertised checkpoint format.

This cleanup ships one current system template and leaves tool definitions untouched. It has no legacy template catalog, digest-based migration or compatibility error branch. Old local conversations are cleared explicitly through the existing maintenance command; installing or starting the app does not automatically delete history. Clearing a session also releases its saved presentation, so a new conversation starts with the current policy.

## Checkpoint source references

The existing checkpoint `summary` carries a concise Markdown `<skill_constraints>` section. Each applicable requirement includes its condition and source line link; deferred references explain when and why to read them. Completed one-time actions remain completed facts with their real task/artifact IDs. The model decides applicability; Runtime validates paths, observed revisions and delivered ranges, without keyword-based semantic retirement or a model-authored keep/retire JSON ledger.

`read_file` and `run_skill` feed the same source collector. Skill invocation records the hash of the bytes actually parsed by its loader and the literal source spans delivered in the instructions. Expanded arguments, dynamic command output, activation messages and fork results are not represented as original file lines. Final ingress truncation counts only complete visible lines; the omitted tail retains its existing archive locator. Discovery alone does not count as reading.

Handoff links use `[condition or reread reason](<absolute/path?revision=SHA256#L12-L18>)`. A revision may be omitted when only one observed version exists; receipts bind that reference to the observed hash. Changed versions remain distinguishable. Subsequent `read_file` results must be checked against the saved revision before reusing line positions. Compact receipts store only selected ranges and source metadata, leaving originals in their files and existing Tool archives. This changes neither the frozen system prefix nor top-level Tool declarations and creates no remember file.

Offline regression checks real recorded source snapshots, bounded delivery, changed files, partial acceptance, staged consolidation, repeated compaction and restart. It verifies source transport and the supplied authored handoffs; it does not certify that a model's paraphrase retains every semantic constraint.

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

Both `call_tool` and `mcp_call` use the selected target's channel for batch scheduling, resolving aliases only from that model request. Desktop suppression during concurrent permission requests uses the same target resolution. These hints grant no schema or permission authority. In the coordinator, MCP targets acquire a shared server lease through the existing resource scheduler: unsafe calls are exclusive, explicitly parallel-safe calls share up to eight permits, and different servers remain independent. The lease covers direct, nested and background invocations using the same Runtime registry, and survives observer cancellation until the executor settles. Resource and server leases are acquired together; queued plugin calls recheck their registration and inherited Hook stop state before dispatch. `readOnlyHint` alone does not enable parallelism.

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

## SSH execution environments

The selected conversation workspace remains authoritative; a saved connection's default directory is only a browsing default. Native Windows paths such as `C:\Users\111` and Windows OpenSSH SFTP paths such as `/C:/Users/111` retain one SSH identity. SFTP's virtual `/` remains browseable, but it is not a Windows shell working directory. UNC/device paths and drive-relative paths are rejected explicitly.

Before running commands, the desktop SSH manager verifies the remote platform once per live connection using a bounded, read-only probe. File operations stay on SFTP without requiring shell access. Windows uses PowerShell or cmd; POSIX hosts retain their existing shell/process-group path. Omitted shell arguments use the remote default, not the desktop OS. A mismatched shell, an unknown platform, or a disconnected transport never causes a local fallback or automatic command replay. Platform information is returned as execution data; the tool catalog and bound model contract are not changed dynamically.

Windows startup uses a short PowerShell bootstrap and stdin for the host prelude and user command, preserving long commands and quoted/Unicode paths without passing them through the login shell. User code is released only after the wrapper owns a named Job Object. Normal descendants inherit that job; closing the wrapper cleans them up. Stop targets this job and verifies it is empty, rather than trusting a PID or merely closing the SSH channel. A failed stop or disconnected transport remains uncertain. This is process lifecycle management, not sandbox isolation; externally managed services are not ordinary descendants. See [Microsoft's Job Object semantics](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

Both platform paths retain exact command/shell/cwd approvals, owner-bound terminal handles, remote home/project/root deletion protection, output limits and existing sandbox restrictions. Required isolation still rejects direct SSH before contacting the bridge; requests for sandbox extensions cannot silently run without enforcement. Search and Git reuse the same platform-aware launcher and argument quoting.

`npm run test:ssh` uses only loopback SSH/SFTP fixtures and local Windows child processes. It covers the selected-directory regression, platform caching, both shells, Unicode and interactive I/O, native quoting, job cleanup, cancellation before dispatch, failed stops, disconnects and Linux compatibility. No user SSH host or model is contacted.

## Multi-file patch

`apply_patch` accepts the `*** Begin Patch` / `*** End Patch` format, Add/Update/Delete files, optional Move to, and exact `@@` contexts. Existing revisions must have been read. The runtime authorizes all paths, validates all changes before writing, locks every target and preserves review/undo evidence. Ambiguous hunks and duplicate paths fail before mutation. A later I/O failure attempts rollback; any remaining changes retain evidence and are reported explicitly. This is a preflighted batch with compensation, not a cross-filesystem atomic transaction. Limits: 64 files, 2 MiB patch text, 32 MiB staged before/after data, and the existing 8 MiB per-file limit. SSH continues using its routed individual file tools.

## Tool scripts

`run_tools` executes an async JavaScript function body in a separate QuickJS/WASM heap. It provides `tools.NAME(args)` and `tools.call(name, args)`, JSON data and JavaScript transforms. It exposes no Node, filesystem, network, timer or import APIs. Example:

```js
const file = await tools.read_file({ path: 'records.json' });
return JSON.parse(file.content).sort((a, b) => b.sales - a.sales).slice(0, 10);
```

Scripts start as turn-owned background tasks, so awaiting a tool inside the script does not suspend the model's next independent step. Each nested call has its own ordinary journal record. Safe calls may run concurrently; unsafe calls in one channel remain ordered. Await dependent writes explicitly.

Budgets: 64,000 code characters, 32 calls, 8 admitted calls at once, 32 MiB guest memory, 1 second total guest CPU with 250 ms slices, 5 minutes wall time including queue waits, and 2 MiB final serialized data. Additional calls within the 32-call budget queue instead of failing at the ninth call. Script slots and channel leases are acquired together so a busy channel does not occupy every slot. Queue admission precedes nested Hooks and permissions; cancelled or Hook-stopped items retain individual undispatched journal receipts. Use `Promise.allSettled` when partial success is useful and inspect each rejection. Successful calls are never automatically replayed. Unawaited tool operations are drained before successful completion. Failure or cancellation may leave completed effects; review their existing records before rerunning. Hooks can stop the parent turn even when a nested call completes after the initial script handle was returned.

Regression coverage is in `packages/bush-runtime/test/unifiedToolSystem.test.mjs`, `builtinToolDisclosure.test.mjs`, `builtinToolInvocation.test.mjs` and `packages/bush-provider-openai/test/anthropicProgressiveTools.test.mjs`, with existing task, journal, permissions, Team, workspace, MCP and model-loop tests retained. The Anthropic integration uses the real SDK with mock HTTP/SSE and verifies exact prefixes across Team/employee editing, tool results and subsequent turns.

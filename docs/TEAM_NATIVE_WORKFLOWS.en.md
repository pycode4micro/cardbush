# Built-in Team and registered employees

[English](TEAM_NATIVE_WORKFLOWS.en.md) · [简体中文](TEAM_NATIVE_WORKFLOWS.md)

[中文](TEAM_NATIVE_WORKFLOWS.en.md) | [Documentation](README.md)

Team is built into Runtime, available from the Team page and the composer's `/team` picker without installing a plugin. The main Agent and local text assistant can manage employees and dispatch workflows; calls retain their lightweight delegation interface.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| `subagent` fork | Copy a snapshot of the parent conversation and intent at dispatch. Later parent input is not synchronized; explicitly send follow-up work using `task_id`. |
| `subagent` clean | Independent role instructions, tool scope, generation settings, trusted Hook references and a read-only guard. Configure it temporarily or reuse a registered `agent_id`. |
| `team` | Save workflows, validate dependencies, schedule registered employees with a parallelism limit, retain results and explicitly resume unfinished work. Nodes use the same subagent dispatcher, not a second model loop. |

Employee and workflow definitions belong to the current Runtime host. Employees may use configured host models; new tasks without a model setting inherit the caller's current default. Caller and host permissions/tool restrictions always apply.

## Employees and conversations

`list_subagent_options({})` returns employee summaries, plugin roles and remote Agents without duplicating complete tools/configuration. Employee/tool catalogs support `query` and `next_offset`. Supply `agent_id` for a complete employee definition or `agent_type` for a plugin role. Use `section: "settings"` for models, defaults and trusted Hooks, or `section: "tools"` for tool scope. See [Progressive tool discovery](PROGRESSIVE_TOOL_DISCOVERY.en.md).

Register through `subagent`:

```json
{"action":"save","expected_revision":0,"agent":{"id":"warehouse","name":"Inventory reviewer","description":"Check inventory and shipment conditions","system_prompt":"Answer only from inventory records; identify missing evidence.","guards":["read_only"]}}
```

Creation uses `expected_revision: 0`. Updates and deletion require the current revision to prevent overwriting another editor. Start a new task with:

```json
{"agent_id":"warehouse","prompt":"Check available inventory for SKU-42."}
```

Each new task has an independent conversation; `task_id` continues an existing task's history. Execution reuses SessionStore, conversation journals, compaction and recovery. The role definition freezes at initial dispatch; changing registration affects new tasks, not existing roles.

Continuation reads that task's history, summaries and execution records. Registered employees do not reference the main user's habits or predictions. Read-only employees cannot run modifying tools.

Hooks reference installed, already trusted Hook IDs. Registration cannot install arbitrary executable scripts or grant trust; global host Hooks still apply. The current built-in guard, `read_only`, rejects modifying calls before execution. Disabled/deleted employees cannot start or resume; deleting registration retains historical conversations.

## Team tools

`team` supports `list`, `get`, `save`, `delete`, `run` and `resume`. Use **`tasks`** for progress, results, waiting and stopping, rather than obsolete `team status/wait/stop` actions. `list` returns workflow summaries, or current-conversation execution summaries with `section: "runs"`. `get` reads a full definition. `save` returns a short ID/revision receipt.

```json
{"action":"save","expected_revision":0,"definition":{"id":"order-check","name":"Order review","max_parallel":2,"nodes":[{"id":"stock","agent_id":"warehouse","prompt":"Check inventory for the order"},{"id":"review","agent_id":"reviewer","prompt":"Use the inventory result to check shipment conditions","depends_on":["stock"]}]}}
```

All nodes reference registered, enabled employees. Independent nodes can run concurrently. Dependent nodes wait and receive only direct upstream results plus the run input. Saving rejects self-dependencies, missing dependencies, duplicate nodes and cycles.

```json
{"action":"run","team_id":"order-check","input":"Check whether order 42 is ready to ship."}
```

The result includes `run_id` and `task_id` for the same execution. Team cancellation is independent: finishing the parent turn or cancelling observation does not stop it. Call `tasks` with `action: "inspect"`, `"wait"` or `"stop"` and the execution handle in `task_ids`. Do not substitute the workflow's `team_id` or a node ID. Completed tasks return immediately; polling first is unnecessary.

`tasks inspect/wait` returns full outputs for final nodes (nodes without dependents), plus all node statuses, identities and `has_output`. Multiple final branches are all included; `result_node_ids` identifies them. To trace intermediate evidence, use `tasks({"action":"inspect","task_ids":["returned-run-handle"],"node_ids":["stock"]})`. Selected outputs are not truncated. Full results remain in storage and management views.

A running main conversation receives completion notifications; the text assistant can continue after background completion. Notifications contain final outputs and node statuses, not lengthy intermediate results. If the same final-result revision was already consumed through `tasks inspect/wait`, it is not reinjected or used to trigger another assistant response. Reading intermediate evidence does not consume final delivery. Resume creates a new result revision and can notify again. A finished main conversation can retrieve results with `tasks` on a later turn.

`completed` means execution ended, not independent content validation. Specify deliverables and acceptance criteria in node tasks. Employees work from instructions/upstream evidence; the parent checks conclusions and gaps and distinguishes verified facts from recommendations. Explain timing only from evidence, not an assumed model load.

Failure stops dispatching downstream nodes; already running siblings finish. `resume` retains successful nodes and continues established failed-node conversations. After restart, unfinished runs become `interrupted` and require explicit resume; potentially consequential actions are not automatically replayed. Workflow and employee snapshots remain fixed for that run.

## Storage and UI

Team is available in the app center. Team documents reuse [bush-it](BUSH_IT.en.md)'s Markdown editor and document view, with full articles by default and optional relation diagrams. `.md` import/export supports prose alongside execution tasks; document references do not create execution dependencies. The chat Inspector initially shows a read-only document.

Optional `presentation.markdown` stores rationale, headings and notes. Execution-only updates omitting it preserve the article. Display reflects actual `nodes` and `depends_on`. Article prose is not implicitly sent to employees; explicit node instructions, run input and direct upstream results are.

- `<runtime data root>/registered-agents`: versioned employee definitions.
- `<runtime data root>/teams/definitions`: workflows.
- `<runtime data root>/teams/runs`: node states, execution snapshots, results and errors.
- Existing conversation directories: context persistence and recovery.

Management uses `runtime.agent_registry` and `runtime.team_workflow` over the same storage. Starting/resuming requires an Agent turn with model and permission context; UI handles editing, viewing and stopping. The old `team` plugin no longer loads, and its configuration is not automatically migrated.

Conversation previews distinguish employee registration, Team registration and execution. Registration receipts open the current definition; Team member details open employee roles, shown by responsibility names and badge icons. Historical summaries retain operation, identity and task ID without full role instructions. Opening details fetches the current definition through `get`, with configuration initially collapsed. Registration/deletion do not emit child-dispatch events.

The `/team` picker supports search, arrows, Home/End, Enter/Tab and Escape. Selection is an explicit draft reference and stays clickable after sending or reopening history. It opens the workflow/member details, saves identity only and does not execute or append full configuration. The workspace's default Team is recorded at send time; explicit draft selection takes precedence, and later default changes do not rewrite submitted messages.

## Verification

`npm run test:team` covers registration/conflicts, fork/clean isolation, independent sessions/continuation, read-only enforcement, DAG scheduling, parent exit, stop/resume, restart interruption, real Runtime sessions, text-assistant dispatch and management UI.

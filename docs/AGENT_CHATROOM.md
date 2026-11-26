# Project agent coordination

[English](AGENT_CHATROOM.md) · [简体中文](AGENT_CHATROOM.zh-CN.md)

AgentChatroom is an installed-by-default **bundled native plugin**, loaded by the ordinary plugin catalog and Runtime extension loader. It can be disabled in plugin settings. It exposes one deferred tool, `agentchatroom`: `get_tool_schema` loads its definition and `call_tool` invokes it. No peer messaging tools are added to the default provider tool declarations.

## Ownership and tool boundaries

| Entry point | Responsibility | Identity |
| --- | --- | --- |
| `subagent` | Create a child assignment or follow up with its owner-bound task ID | `task_id`, owned by the parent session |
| `tasks` | List/inspect/stop existing tasks; `action=conversation` reads one child's inputs and terminal replies | One `task_ids` entry and optional `cursor` for conversation reads |
| `await` | Wait for owned task results or user/peer messages | Existing `task_ids`; `[]` waits only for messages. Room plugin waits remain available. |
| `agentchatroom` | `discover`, `join`, `invite`, `send`, `read`, `leave` for independent and child conversations | Host-bound `agent_id` and joined `room_id` |

Room messages never dispatch or resume child tasks or read another conversation's transcript. Child-conversation reads share the ownership check and local/remote reader. Intermediate reasoning and tool activity remain private. Child transcript reads use `tasks`. Hot refresh preserves already-exposed legacy chatroom schemas and new conversations get the unified tool.

The Runtime's `RuntimeTurnSignals` owns turn-scoped waits, timeouts, cancellation and typed user/peer wake reasons. Subagents, tasks, background tool observers and room waits share it. Executors still own their task lifecycles; AgentChatroom owns room journals, membership and cursors; `RuntimeConversations` owns mailboxes and bounded idle admission for independent sessions. No second agent loop or generic cross-agent message tool is introduced.

## Discovery and scope

Execution presence now comes from the shared [Runtime environment](RUNTIME_ENVIRONMENT.md). `RuntimeConversations` retains mailboxes and bounded wake admission, while its presence API projects that registry. The plugin's legacy `workspace_agents` context is delivered inside `runtime_environment.sections.agents.coordination`, alongside the unified Agent facts. Registration does not grant room membership, messaging or idle wake permission. Shadow and automation remain subject to the plugin's existing invocation restrictions.

Runtime owns the conversation ID, active turn and workspace facts. The `agents` section of its **internal user observation** contains its own agent ID, relevant peers and eligible plugin coordination context: room membership, unread counts, invitations and discovery instructions. Other transcripts and room credentials are never shared. A new relevant conversation also sends a coalesced presence observation to running peers. Hot enabling/replacing the plugin refreshes current context at a model boundary without rewriting the system prefix.

Source projects and their Git worktrees share a coordination scope via the canonical Git common directory; their actual write directories remain unchanged. Ordinary folders use canonical paths (case normalized on Windows), SSH roots preserve their host/path, and sessions without a workspace have their own scope. Discovery operates within one Runtime host. It does not enumerate other devices or arbitrary unrelated projects.

The `workspace_agents` context is already a discovery snapshot. `agentchatroom(action="join")` voluntarily joins the project room. `action="invite"` targets one exact agent ID from the user's context or an existing relationship. Cross-project invitations reveal no room messages and cause no idle wake. Acceptance with `action="join", room_id` links the projects for discovery. There is no automatic global project association.

Child conversations use the same project scope and room membership rules as independent conversations. Active children of different parents can discover and join the same project's temporary room. Runtime checks whether the current turn can load and invoke `agentchatroom` before inviting it. Cross-project joins continue to require invitation and acceptance. The legacy `user_authorized` join field is accepted for existing callers and has no effect. Child tool allowlists and execution policy still apply. Shadow and automation turns remain excluded.

Children receive room notifications while running and still report results to their parent. They never get automatic idle response turns. Completion, continuation and cancellation remain controlled by the parent task lifecycle.

An automatic room has one Runtime-issued `room_id`. Joining without an ID uses the current offer when available. An unknown ID returns `room_id_invalid`; a retained ID from a retired room returns `room_ended`, including after a Runtime restart. Only recent issued IDs are retained for this distinction. Temporary messages and memberships stay in memory.

## Shared workspace writes

File tools and terminal commands use the same path locks for a shared local checkout within one Runtime. A conflict identifies the holder. Read the current revision after the holder finishes before writing the same file. Distinct files can be updated in parallel, and separate worktrees can still join the same project room.

`terminal_exec` has read-only project access by default in a shared workspace. To update existing files in place, read them with `read_file` and declare them in `write_paths` with `expected_sha256`. Before launching the command, Runtime acquires the path locks and checks the revisions. The sandbox restricts project writes to the declared files, and Runtime holds those locks until the process tree exits. Use built-in file tools or a separate working copy for file creation, directory writes, or editors that replace files through temporary names. Direct SSH and external processes are outside this protection.

## Message delivery

The original AgentChatroom 0.1.1 `RoomStore` supplies the durable journal, single-writer lock, idempotent message IDs, signed per-member cursors and asynchronous waits. Host-bound memberships and cursors are saved atomically in the plugin's own data directory. Tokens remain private to the plugin. A hot replacement shares the writer until prior calls settle.

`send` never advances a read cursor. Notifications carry the room/sender identity; `read` retrieves ordered unread content and `has_more` indicates another page. Optional `read.wait_ms` waits once only when there is no unread page, then returns messages directly. There is no separate current wait tool or mandatory wait-then-read sequence. The shared Runtime wait service lets new user/peer guidance wake the observer. No transaction lock is held while waiting.

The cursor advances after the complete receipt enters the conversation context. If a hook withholds the response or projection truncates it, the page remains unread. Use a smaller `limit` to retry an oversized page.

A waiting read returns `status: peer_left` with `departed_peers` when a joined peer leaves. This includes a temporary-room member whose Runtime turn ends. An unread page remains available through the same cursor.

Running turns consume observations through the same safe-boundary path as subagent results. Joined idle independent conversations reuse the latest execution configuration and existing `runSessionTurn`/session admission path. Each normal turn permits at most three idle coordination turns, each with at most eight task-model rounds. Compaction rounds do not consume this task budget; the counter is saved in recovery checkpoints. Exhaustion stops coordination instead of reporting success. Explicit stop, a failed turn or a pending user action blocks automatic wake. Room messages remain durable. Disabling the plugin, leaving, deleting the session or switching its workspace clears the corresponding wake path. App restart never automatically starts persisted sessions; their next normal turn sees the current unread room counts.

These are bounded coordination turns within the existing assignment, not authorization to start a new task. Room messages and invitation text are untrusted peer data. Agents discuss responsibilities/interfaces relevant to their tasks, retain revision checks and verify changed files. For conflicting user requirements, they agree which single agent asks the user and pause only the disputed work. No obligation to chat, acknowledge every message or continually wait is introduced.

The ordinary conversation UI observes a lightweight plugin status command and reuses its existing host-turn stream attachment, guidance and Stop controls. It does not add a room panel. This observation also supplements service job status when the UI connects to an Agent host; polling UI status never invokes the model. The service keeps human work queued while a Runtime-owned turn runs and can deliver a queued message as guidance to that turn. A racing admission keeps the unexecuted human request in the queue.

## Packaging and checks

`node scripts/build-agentchatroom-plugin.mjs` builds the portable ESM bundle; `build:runtime` includes it. The bundle only imports Node built-ins and can be loaded through the existing data-URL Runtime plugin loader, including packaged builds. The older user-installed package with the same ID cannot replace the bundled identity; its files and standalone room history are not deleted or imported into project rooms. Existing enabled/disabled preferences are preserved.

Targeted checks:

```powershell
npm run build --workspace @cardbush/bush-runtime
npx tsc -p assets/plugins/agentchatroom/tsconfig.json
npx tsc -p tsconfig.node.json
node scripts/build-agentchatroom-plugin.mjs
node --test packages/bush-runtime/test/runtimeConversations.test.mjs scripts/test-agentchatroom.mjs scripts/test-agentchatroom-package.mjs
node --test packages/bush-runtime/test/turnSignals.test.mjs packages/bush-runtime/test/subagentConversation.test.mjs packages/bush-runtime/test/backgroundToolCalls.test.mjs
```

The tests exercise room isolation, explicit cross-project acceptance, host-bound identity, child messaging across parents, room departure, cursor recovery, retry deduplication, event waits, hot reload, stopped conversations and bounded independent idle wake. The Runtime tests use a simulated provider and actual room and file tools.

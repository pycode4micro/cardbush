# Project agent coordination

AgentChatroom is an installed-by-default **bundled native plugin**, loaded by the ordinary plugin catalog and Runtime extension loader. It can be disabled in plugin settings. It exposes one deferred tool, `agentchatroom`: `get_tool_schema` loads its definition and `call_tool` invokes it. No peer messaging tools are added to the default provider tool declarations.

## Ownership and tool boundaries

| Entry point | Responsibility | Identity |
| --- | --- | --- |
| `subagent` | Create a child assignment or follow up with its owner-bound task ID | `task_id`, owned by the parent session |
| `tasks` | List/inspect/wait/stop existing tasks; `action=conversation` reads one child's inputs and terminal replies | One `task_ids` entry and optional `cursor` for conversation reads |
| `agentchatroom` | `discover`, `join`, `invite`, `send`, `read`, `leave` for independent conversations | Host-bound `agent_id` and joined `room_id` |

Tasks do not join rooms; room messages never dispatch/resume child tasks or read another conversation's transcript. Both child-conversation entry points use the same ownership check and local/remote reader. Intermediate reasoning and tool activity remain private. The former seven chatroom names and `read_subagent_conversation` remain compatibility handlers for saved conversations; the current catalog advertises only their replacements. Hot refresh preserves already-exposed legacy schemas without adding legacy names to new conversations.

The Runtime's `RuntimeTurnSignals` owns turn-scoped waits, timeouts, cancellation and typed user/peer wake reasons. Subagents, tasks, background tool observers and room waits share it. Executors still own their task lifecycles; AgentChatroom owns room journals, membership and cursors; `RuntimeConversations` owns independent-session presence and bounded idle admission. No second agent loop or generic cross-agent message tool is introduced.

## Discovery and scope

Runtime owns the conversation ID, active turn and workspace facts. A `workspace_agents` **internal user message** is appended to a normal independent conversation. It contains its own agent ID, relevant peers, room membership, unread counts, invitations and discovery instructions; other transcripts and room credentials are never shared. A new relevant conversation also sends a coalesced presence observation to running peers. Hot enabling/replacing the plugin refreshes current context at a model boundary without rewriting the system prefix.

Source projects and their Git worktrees share a coordination scope via the canonical Git common directory; their actual write directories remain unchanged. Ordinary folders use canonical paths (case normalized on Windows), SSH roots preserve their host/path, and sessions without a workspace have their own scope. Discovery operates within one Runtime host. It does not enumerate other devices or arbitrary unrelated projects.

The `workspace_agents` context is already a discovery snapshot; an extra discovery call is unnecessary unless stale. `agentchatroom(action="join")` voluntarily joins the project room. `action="invite"` targets one exact independent agent ID from the user's context or an existing relationship. Cross-project invitations reveal no room messages and cause no idle wake. Acceptance with `action="join", room_id` links the projects for discovery. There is no automatic global project association.

Child, delegated, Shadow and automation turns are not advertised as independent peers. The plugin registrations use `visibleToChild: false`; the existing execution-time child policy enforces this even through `call_tool` and inherited schemas. The plugin also validates the active host-bound identity. Parent/child messaging is unchanged.

## Message delivery

The original AgentChatroom 0.1.1 `RoomStore` supplies the durable journal, single-writer lock, idempotent message IDs, signed per-member cursors and asynchronous waits. Host-bound memberships and cursors are saved atomically in the plugin's own data directory. Tokens remain private to the plugin. A hot replacement shares the writer until prior calls settle.

`send` never advances a read cursor. Notifications carry the room/sender identity; `read` retrieves ordered unread content and `has_more` indicates another page. Optional `read.wait_ms` waits once only when there is no unread page, then returns messages directly. There is no separate current wait tool or mandatory wait-then-read sequence. The shared Runtime wait service lets new user/peer guidance wake the observer. No transaction lock is held while waiting.

Running turns consume observations through the same safe-boundary path as subagent results. Joined idle conversations reuse the latest execution configuration and existing `runSessionTurn`/session admission path. Each normal turn permits at most three idle coordination turns, each with at most eight task-model rounds. Compaction rounds do not consume this task budget; the counter is saved in recovery checkpoints. Exhaustion stops coordination instead of reporting success. Explicit stop, a failed turn or a pending user action blocks automatic wake. Room messages remain durable. Disabling the plugin, leaving, deleting the session or switching its workspace clears the corresponding wake path. App restart never automatically starts persisted sessions; their next normal turn sees the current unread room counts.

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

The tests exercise room isolation, explicit cross-project acceptance, independent identity, child denial, cursor recovery, retry deduplication, event waits, hot reload, stopped conversations, bounded idle wake and actual Runtime context/session delivery with a simulated provider. They do not use paid model requests or guarantee that a model will negotiate a good design.

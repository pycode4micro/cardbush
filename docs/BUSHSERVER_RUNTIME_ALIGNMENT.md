# BushServer to TypeScript Runtime alignment

Baseline: BushServer `main` at `f67bcec` (2026-08-29).

CardBush runs one provider-independent TypeScript Agent Runtime in an Electron
Utility Process. BushServer is the reference implementation and fixture source;
it is not a production process, HTTP dependency, or fallback execution path.

## Deliberate product exclusions

- `ocr_image` is not shipped. Vision input is explicit and gated through
  `inject_image_input` plus provider-native image messages.
- `mcp_manager` and `search_mcp_tools` are not model Tools. The Product Host owns
  MCP configuration and applies one immutable complete snapshot before a Turn.

These exclusions are absent from the Runtime Tool Catalog rather than represented
as disabled or installable Built-ins.

## Aligned Runtime contracts

- Session history is append-only, checksummed and committed by stable Turn and
  message identities. Regenerate/edit uses explicit supersession.
- Semantic context compaction is also append-only: `turn_context_summarized`
  projects prior completed Turns as concise summaries for the model without
  changing raw history replay. At a safe Tool boundary the completed prefix of
  an active Turn may likewise receive one cumulative checkpoint projection;
  exact assistant, Tool and execution facts remain available to history and audit.
- Stop has an independent typed acceptance receipt and is a resumable Session
  boundary rather than a rollback. The active Provider/Tool wait receives one
  uniform 250 ms settlement grace and is then detached when its Promise does not
  cooperate; already observed assistant text, Tool facts and workspace changes
  are committed in one stopped Turn before the
  Session gate is released. The next user Turn extends those facts and inherits
  the prior hash-only Cache Chain snapshot. Late Provider/Tool settlement cannot
  append a second lifecycle fact. Product startup settles orphaned checkpoints as
  `runtime_restart_interrupted` before allowing later work.
- Guidance is queued inside the active Turn and consumed as a user-role message on
  the next provider round. It does not create a hidden replacement Turn.
- Request capabilities default off and keep vision and interactive permission
  requests distinct. `request_permission` owns the pending/reply lifecycle.
- Permission modes are `task_free`, `user_free` and `all_free`; grants bind exact
  actions, resources and capability IDs. UI modes do not silently enable
  `all_free`. Once explicitly selected, `all_free` applies to the full nested and
  child execution tree: ordinary asks are resolved inside Runtime while hard
  admission denials remain final.
- Open Plan nodes trigger bounded structural continuation. Empty responses and
  reasoning-budget exhaustion have separate bounded terminal failures.
- Large Tool results remain complete in the durable Tool execution archive and
  receive a bounded model projection with a `tool-result://` locator readable by
  `read_archived_tool_result`. Parallel results share one context-ingress budget,
  so one Tool batch cannot consume the reserve needed by mandatory compaction.
- Project file observations persist across Sessions, are validated by SHA-256,
  and share a same-resource mutation fence. Workspace revert verifies the current
  after-revision and uses recorded before-images.
- Subagent dispatch returns submitted immediately, runs an ordinary child Turn in
  the background without blocking independent parent rounds, and feeds completed
  results back only at safe round boundaries. Parent completion is guarded by a
  mandatory join-and-reconcile barrier. Child-visible Tools and Team Profile
  disabled-Tool constraints can only shrink the parent's Tool surface.
- Teams require exactly one fallback member and support Profile disabled Tools,
  Skills, trusted Hooks/Guards and prompt instructions. There is no conference,
  peer chat, hidden DAG, automatic routing or Runtime retry policy.
- Shadow conversations are hidden, temporary, read-only, frozen at a source Turn
  and source Session revision, and become stale when that source changes.
- Product shutdown rejects new work, stops active Turns, drains them with a bound,
  closes MCP resources, and only then permits the Utility Process fallback kill.

## Built-in Tool Catalog

The immutable TypeScript Built-ins are:

```text
read_file
search_file_content
write_file
edit_file
terminal_exec
terminal_poll
terminal_write
terminal_list
terminal_stop
parallel_tools
inject_image_input
update_task_plan
update_goal
schedule_task
search_skills
consult_logic
learn_logic
read_archived_tool_result
subagent
team_delegate
request_permission
```

Built-ins are code-owned and cannot be installed, removed, enabled, disabled or
reset from Settings. Runtime asset reset covers Prompts, Skills, Agent Profiles
and Teams only. External executable extensions use MCP.

## Authority and remaining validation boundary

Action Manifest, Runtime invocation status, Workspace Change, usage and terminal
state are structured Runtime facts. Each Tool owns the schema and meaning of its
native return. Runtime does not infer success, paths, delivery, completion or next
actions from prose, and MCP responses cross the boundary unchanged. Product
renderers may consume standard MCP content blocks or explicit tool-owned fields.

The release gate still requires real-provider A/B coverage for Stop during a
provider stream, Tool cancellation, Guidance races, Subagent/Team concurrency,
vision input and MCP shutdown. These are deployment validation obligations, not
alternate product paths or missing Tool registrations.

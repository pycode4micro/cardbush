# BushServer to TypeScript Runtime alignment

Baseline: BushServer `main` at `f67bcec` (2026-08-29).

CardBush runs one provider-independent TypeScript Agent Runtime in an Electron
Utility Process. BushServer is the reference implementation and fixture source;
it is not a production process, HTTP dependency, or fallback execution path.

## Deliberate product exclusions

- `ocr_image` is not shipped. Vision input is explicit and gated through
  `inject_image_input` plus provider-native image messages.
- `browser_ops` is not shipped. Computer Use is an external Tool supplied by the
  bundled, independently managed `cardbush_apps` MCP server.
- `mcp_manager` and `search_mcp_tools` are not model Tools. The Product Host owns
  MCP configuration and applies one immutable complete snapshot before a Turn.

These exclusions are absent from the Runtime Tool Catalog rather than represented
as disabled or installable Built-ins.

## Aligned Runtime contracts

- Session history is append-only, checksummed and committed by stable Turn and
  message identities. Regenerate/edit uses explicit supersession.
- Stop has an independent typed acceptance receipt. The live event stream remains
  authoritative until `turn_terminal`; generated text, Tool facts, artifacts and
  workspace changes remain durable. Product startup settles orphaned checkpoints
  as `runtime_restart_interrupted` before allowing later work.
- Guidance is queued inside the active Turn and consumed as a user-role message on
  the next provider round. It does not create a hidden replacement Turn.
- Request capabilities default off and keep vision, interactive requests and
  ordinary user choice distinct. `request_permission` and
  `request_user_choice` have separate pending/reply lifecycles.
- Permission modes are `task_free`, `user_free` and `all_free`; grants bind exact
  actions, resources and capability IDs. UI modes do not silently enable
  `all_free`.
- Open Plan nodes trigger bounded structural continuation. Empty responses and
  reasoning-budget exhaustion have separate bounded terminal failures.
- Large Tool results remain complete in the durable Tool execution archive and
  receive a bounded model projection with a `tool-result://` locator readable by
  `ked_read_temp_object`.
- Project file observations persist across Sessions, are validated by SHA-256,
  and share a same-resource mutation fence. Workspace revert verifies the current
  after-revision and uses recorded before-images.
- Subagent dispatch returns submitted immediately, runs an ordinary child Turn in
  the background, and feeds its result back to the same parent Turn. Child-visible
  Tools and Team Profile constraints can only shrink parent capabilities.
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
parallel_tools
inject_image_input
update_task_plan
update_goal
schedule_task
search_skills
skills_manager
consult_logic
learn_logic
ked_knowledge
ked_read_temp_object
subagent
team_delegate
request_permission
request_user_choice
interior_cad_inspect
interior_cad_draw
interior_design_validate
```

Built-ins are code-owned and cannot be installed, removed, enabled, disabled or
reset from Settings. Runtime asset reset covers Prompts, Skills, Agent Profiles
and Teams only. External executable extensions use MCP.

## Authority and remaining validation boundary

Action Manifest, Execution Fact, Artifact, Workspace Change, usage and terminal
state are structured facts. Runtime does not infer success, paths, delivery,
completion or next actions from prose. Generic MCP content remains displayable;
only an explicit authority envelope can introduce authoritative facts.

The release gate still requires real-provider A/B coverage for Stop during a
provider stream, Tool cancellation, Guidance races, Subagent/Team concurrency,
vision input and MCP shutdown. These are deployment validation obligations, not
alternate product paths or missing Tool registrations.

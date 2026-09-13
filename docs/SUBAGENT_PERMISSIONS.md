# Child Agent baseline configuration

CardBush freezes one explicit child-Agent baseline into every new root Turn. Both
ordinary fork Subagents and Team member children reuse that baseline. A Team/Profile
may narrow the exposed tools and add role instructions, skills, hooks and guards,
but it cannot silently relax the baseline that was frozen for the Turn.

The advanced local configuration file is intentionally not exposed as a general
GUI form:

```text
<Electron userData>/product-host/config/subagents.json
```

Default configuration:

```json
{
  "protocol": "cardbush.subagent_configuration.v1",
  "permissionRouting": "user",
  "childPermissionMode": "task_free",
  "model": {
    "mode": "inherit"
  },
  "disabledTools": [
    "subagent",
    "await_subagents",
    "team_delegate",
    "request_permission",
    "update_goal",
    "schedule_task"
  ]
}
```

Unknown fields are rejected. The legacy permission-only file is migrated to the
versioned shape. Changes affect future root Turns only; an active Turn and all of
its children continue with their immutable snapshot.

## Permission routing

- `user` (GUI label **Unified**) makes every child inherit the parent Turn's
  user-selected `permissionMode` and capability scope. This is the default.
- `parent` (GUI label **Model approval**) keeps the parent's user-selected mode,
  while children use `childPermissionMode` and a separate child Session scope.
  Child permission events are still tunnelled through the active parent Turn.

`all_free` is the inherited execution-tree default: when the root Turn uses full control,
children also use `all_free` regardless of routing. Ordinary permission asks are
resolved inside Runtime and never tunnel to the GUI; hard admission denials remain
non-overridable. An explicit clean dispatch may choose a lower permission mode;
changing its permission routing never raises the pre-existing permission ceiling.

The Composer route is a per-Turn product choice and takes precedence over the
file's `permissionRouting`. `childPermissionMode` accepts `task_free`,
`user_free`, or `all_free`; elevated values are configuration-only and emit a
startup security warning when used with `parent` routing.

## Model policy

`{"mode":"inherit"}` reuses the parent Turn model. To pin all child execution to
an existing Product Host model, store only its stable ID:

```json
{
  "mode": "fixed",
  "modelId": "reviewer-model"
}
```

The Product Host resolves that ID at root-Turn creation and passes an opaque
Runtime provider binding. Provider keys and endpoints are never duplicated into
the Subagent configuration or Turn metadata.

## Explicit tool restrictions

`disabledTools` is a runtime admission deny list copied to child Turn metadata.
It no longer removes tool declarations. Ordinary inherited Subagents keep the
parent's frozen definitions in the same order, while explicit Profile allowlists
may still narrow the catalog. Restricted calls return `child_agent_tool_unavailable`
before hooks, permission requests or execution. A Profile cannot re-enable a
baseline-disabled tool.

`subagent`, `await_subagents` and `team_delegate` remain visible but are always
unavailable when `agentRole` is `child`, even with an empty `disabledTools` list
or `all_free` permission mode. Calls return `child_agent_dispatch_unavailable`
and explain that the child should finish its assignment and report dependencies
to the parent. The same restriction covers plugin Skill/Command `context: fork`;
ordinary inline Skills remain available under the existing task policy.

`team_delegate` is now supplied only by the optional Team plugin. Keeping its name in a child-policy exclusion list does not register or enable the tool; ordinary Subagents remain part of the core Runtime.

## Fork and clean dispatch

`subagent.mode` defaults to `fork`. Normal delegation uses fork, including
self-contained tasks. Choose `clean` only when the user explicitly requests
independently configured execution. Parent Agents should not spend a setup step
composing a clean configuration for ordinary parallel work.

In fork mode root and child Agents use the same system policy. A dispatch copies
the exact pre-dispatch messages, including system and developer messages, then
appends any explicit role instructions and a user assignment beginning with
`你当前处于子agent状态`. It does not rewrite the parent history, tool definitions,
or their order. `system_prompt`, `allowed_tools` and `settings` are clean-only
arguments and are rejected in fork mode.

For clean mode, the parent calls `list_subagent_options` and chooses the applicable
settings itself. The host supplies configured model IDs and limits, current tool
and Skill scope, permission ceiling and installed Agent roles. Model credentials
are resolved inside the host and are never included in this catalog. Skills can
be discovered with `search_skills` within the displayed scope.

The required `system_prompt` becomes the actual system message; `prompt` becomes
the user assignment, preceded by the same child-state reminder. Neither parent
conversation history nor the inherited system prompt is copied. The parent must
supply necessary facts, the user's communication language, desired behavior and
output requirements. Selecting an `agent_type` also applies that installed role's
instructions, restrictions and environment.

Clean settings expose `model_id`, `reasoning_effort`, `max_context_tokens`,
`max_output_tokens`, `temperature`, `top_p`, `max_turns`, `permission_mode`,
`permission_routing`, `disabled_tools`, `allowed_skills` and `disabled_skills`.
The separate `allowed_tools` is an exact allowlist; omitting it retains the parent
catalog, while `[]` permits no tools. Plugin setup cannot re-add excluded MCP or
memory tools, and admission enforces the same allowlist. Optional `agent_type`
and `run_in_background` are advertised when the host supports them. Unspecified
values use the displayed host defaults. Token limits cannot exceed the selected
configuration, execution limits respect any selected role, and explicit scopes
intersect with host restrictions. Internal task identity and recursive-dispatch
restrictions are not parent-configurable.

Example after the user requests independent configuration:

```json
{
  "mode": "clean",
  "system_prompt": "You review supplied code. Report progress and findings in Chinese.",
  "prompt": "Review the supplied change for correctness. I will implement the UI while you check it. Report actionable findings with file locations.",
  "allowed_tools": ["read_file"],
  "settings": {
    "reasoning_effort": "high",
    "max_turns": 12,
    "permission_mode": "task_free"
  }
}
```

Already-issued legacy `inherit_context` calls remain decodable. Legacy `false`
keeps its prior shared fallback prompt unless a custom system prompt was supplied;
this compatibility path is not advertised. New calls use only `mode`, and cannot
combine both switches.

The policy encourages identifying useful parallel preparation early. Assignments
explain the child's work, the parent's concurrent next steps, pending dependencies
and the intended handoff. Planned future inputs must not be presented as facts.

Matching model parameters, tool declarations and message prefixes permit provider
prefix-cache reuse. Explicit model changes, narrowed role tools, omitted history,
or provider cache behavior can still affect cache hits; no hit is guaranteed.

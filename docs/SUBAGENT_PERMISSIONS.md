# Child Agent baseline configuration

CardBush freezes one explicit child-Agent baseline into every new root Turn. Both
ordinary Subagents and Team member children reuse that baseline. A Team/Profile
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

`all_free` is an execution-tree invariant: when the root Turn uses full control,
children also use `all_free` regardless of routing. Ordinary permission asks are
resolved inside Runtime and never tunnel to the GUI; hard admission denials remain
non-overridable.

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

`disabledTools` is the authoritative baseline deny list and is copied to child
Turn metadata for diagnostics. Ordinary Subagents and Team members therefore
explain the same effective restriction set. Profile tool selection is intersected
with this list; a Profile cannot re-enable a baseline-disabled tool.

`subagent`, `await_subagents` and `team_delegate` are explicit defaults instead of
hidden implementation rules. This keeps today's one-level delegation easy to
audit and leaves a deliberate configuration boundary for a future recursive
delegation design. Removing them is an advanced action and must be paired with
bounded depth, cancellation and permission review before it is treated as a
supported product mode.

# Permissions

The composer exposes two choices on both desktop and connected Agents:

- **Ask for approval / 申请批准**: ordinary file operations can use the authorized
  workspace. Access outside that scope, unsandboxed commands, and other tools
  whose admission requires approval pause for a user decision.
- **Full access / 完全访问**: ordinary tool permission requests pass without a
  prompt. Hard denials, host-enforced command isolation, and operating-system
  permissions still apply.

This follows Codex's separation between approval policy and execution boundaries:
https://learn.chatgpt.com/docs/sandboxing

It is not an automatic risk reviewer. There is no additional model request or
Auto-review mode in this implementation. It is also not an ask-before-every-read
mode. Sandbox setup lives in Settings → Runtime. Detection never installs dependencies;
the user clicks Install when needed, and successful installation enables isolation by
default. Existing opt-outs persist across detection and restart; see `EXECUTION_SANDBOX.md`.
With host mode `auto`, approval mode runs routine commands inside the sandbox,
while full access runs ordinary processes. Mode `required` enforces the host
boundary regardless of the UI selection.

Settings are host-owned and loaded once per command invocation. Changing the setting
does not alter a running command or a pending approval, and does not change tool schemas
or rewrite model history. Explicit deployment modes `off` and `required` remain locked.

## Command approval

An unsandboxed command requires approval even when its working directory is
inside the project. An approved directory does not confine what that command
can access. Session grants bind the exact command text, interpreter, canonical
working directory, and execution host. Changing any of them requires another
approval. Direct SSH execution uses the same rule.

Input to an unsandboxed terminal is bound to the exact input, original host, and
terminal session. Polling and empty input do not require additional approval.
An actually sandboxed terminal can continue within its existing boundary.
Full access bypasses these ordinary prompts through the shared coordinator.

Required command isolation continues to allow workspace execution inside the
host's sandbox. It rejects requests exceeding the deployment's hard limits
without offering an approval that cannot take effect.
Protected deletion is denied before any ordinary permission bypass.

In `auto`, `additional_permissions` can request read/write directories and
network access. Approvals bind the exact command and canonical scope; they
expand only that process and its descendants, retaining OS isolation. An
outside cwd is shown as an additional writable directory. New processes do not
inherit this grant unless the same exact invocation has session approval.
Directory links changed while awaiting approval invalidate the grant. Network
access is currently all destinations, explicitly shown in the request.

A denial returns a tool failure explaining that the same action must not be
retried indirectly. The existing tool-result mechanism appends that feedback;
it does not rewrite the system prompt or introduce a new loop-abort threshold.

## Compatibility and cache

The wire values remain `task_free` and `all_free` so desktop requests remain
readable by existing Agent services. Saved UI `user_free` choices normalize to
`task_free`; saved full access remains full access. The legacy `user_free`
protocol value is still accepted for old API clients and child configurations.
Historical session messages and tool definitions are not rewritten.

Changing approval mode does not add or remove `request_permission` from the
model catalog. Whether interactive tools are enabled remains a separate
capability. Decisions happen during execution and tool feedback is appended.

The new command-approval behavior is implemented in the shared Runtime. A
connected Agent must be updated to this version to enforce it; updating only
the desktop changes its picker and saved preferences, not an old server's
execution policy.

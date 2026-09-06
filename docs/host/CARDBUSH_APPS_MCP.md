# CardBush Apps MCP boundary

`cardbush_apps` is a standalone MCP 2.x stdio server bundled with the CardBush
desktop distribution. Electron launches it as a child process and the Runtime
connects through the same MCP client and Tool Registry used for user-installed
servers. It does not open an HTTP port.

## Ownership

- `@cardbush/bush-runtime` owns immutable Built-in Tools, admission, permissions,
  invocation lifecycle, Workspace Change recording, Turn lifecycle and recovery.
- `@cardbush/apps-mcp` owns CardBush-shipped app plugins. The initial plugin is
  `computer_use`.
- Product Host owns model and plugin configuration, but never plugin execution.
- External Bot, Browser, Office and other products remain independent MCP servers.

The Runtime must never hard-code a `computer_use` handler or a private
`host_tool_request` transport. A plugin is visible only after MCP discovery and is
namespaced by the MCP client. Tool behavior is described with standard MCP schema
and annotations; results remain standard MCP `CallToolResult` values. CardBush
does not require a private result envelope or server-issued Runtime facts.

## Process lifecycle

The bundled server ID `cardbush_apps` is reserved. Renderer-stored MCP
configuration cannot replace it. When enabled, Runtime injects the server into its
MCP snapshot, launches it with Electron's Node runtime, and closes it with the
Runtime Utility Process. A Product Host revision participates in the Runtime MCP
snapshot revision, so a service or plugin change reconnects the server without
reusing an old snapshot identity.

## Product settings

The Product Host persists `product-host/config/apps.json` and exposes typed
`apps.get` / `apps.update` commands. Settings support:

- enabling or disabling the complete `cardbush_apps` MCP service;
- installing, uninstalling, enabling and disabling individual bundled plugins;
- plugin-owned configuration fields. `computer_use` currently supports a capture
  directory, policy switches for opening applications and closing windows, and
  cooperative controls that yield to user input and restore the pointer after
  mouse actions.

Computer Use remains a last-resort route for visible native UI. Desktop access is
serialized across sessions, input actions are bounded by fresh observations, and
unchanged repeated actions are stopped before they become an unattended loop.
The cooperative mode does not claim OS-level isolation: a separate Windows
session or VM cannot control applications already open on the user's desktop.

An unscoped `observe` call is discovery-only and does not capture the full
desktop. A second `observe` call targeting one exact HWND captures that window, returns bounded UI Automation elements and
issues a one-use `state_id`. Every existing-window action must present the same
HWND and state ID. The state expires after 30 seconds, is consumed before acting,
and becomes stale whenever another Turn changes the shared desktop. Semantic element actions (`click` by
index, `invoke`, and `set_value`) are preferred because they do not normally move
the pointer; window-relative SendInput remains a guarded fallback.

Observation never activates a background window. Target observations report
`is_foreground`; `actionable` means input is ready in the foreground, while
`window_action_available` permits window operations with the fresh state ID.
For a background target, call `window` / `activate`, then observe that HWND again
before sending input. Activation validates the observed HWND, process and bounds
directly, including secondary application windows, and fails if Windows does not
actually bring the target forward. Focus changes count as observation progress.

State and presentation rejections before target dispatch do not count as
unchanged action cycles. They retain a same-action retry limit and a separate
budget of six preflight failures, so a different corrective action remains
possible without allowing an endless invalid-action loop. Failures after target
dispatch remain conservatively counted because input may have partially run.
User takeover, explicit stop and one-use observation checks still apply.

Regression coverage includes the Apps MCP unit suite and the opt-in Windows
suite `npm run test:native --workspace=@cardbush/apps-mcp`. It opens disposable
WinForms, WPF and uniquely titled Windows Terminal fixtures. Run desktop suites
serially on an interactive Windows desktop; terminal tests require `wt.exe`.
Independent application IPC and marker files verify effects, rather than tool
dispatch acknowledgements. Reports and screenshots are written to temporary
directories. See `../COMPUTER_USE_TEST_REPORT_2026-09-05.md` for coverage.

Discovery enumerates visible top-level windows, including secondary windows in
the same process. A concurrent request rejected as busy never cancels the owning
request, including when both requests belong to the same scope.

Long text is dispatched a Unicode code point at a time, with foreground and
process checks between characters. The presentation hook drops tagged input
downs after focus loss or pause; release events remain allowed to avoid stuck
keys/buttons. Dragging rechecks the target and path. This remains cooperative
desktop control, not an OS security boundary.

Progress detection includes a bounded hash of visible, non-password UIA
TextPattern content, so small terminal/document changes need not exceed a global
image-difference threshold. No-progress limits still apply to unchanged output.
A successful input result acknowledges dispatch only: verify the requested
application result in the next observation. In particular, a terminal occupied
by another process may receive characters without executing a shell command.

If target PrintWindow capture fails, observation fails without issuing a state
token. It does not substitute a desktop crop that could show an overlapping
application. Applications that do not support target capture now report this
limitation explicitly.

Uninstall is a local catalog state change: the bundled package remains available
for reinstall, while its Tool is not registered with MCP. Disabling the service
removes the complete server from Runtime's MCP snapshot. Neither operation adds a
Runtime Built-in or a private execution bridge.

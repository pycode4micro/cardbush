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

Uninstall is a local catalog state change: the bundled package remains available
for reinstall, while its Tool is not registered with MCP. Disabling the service
removes the complete server from Runtime's MCP snapshot. Neither operation adds a
Runtime Built-in or a private execution bridge.

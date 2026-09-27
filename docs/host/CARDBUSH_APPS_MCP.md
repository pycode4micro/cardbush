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

CardBush MCP connection management is served separately by Product Host as
`cardbush_management`, using the same standard MCP client and registry. Its
authenticated loopback endpoint exists only for the desktop process lifetime;
it has no separate configuration store. `list_mcp_servers`,
`configure_mcp_server`, and `remove_mcp_server` read or update the existing
Product Host MCP configuration and return the actual Runtime snapshot. It stays
available when optional app plugins are disabled. Server dependencies and add-ons
inside other applications remain owned by their respective installers; registering
a standalone MCP connection does not require a CardBush plugin package.

Configuration updates made during active turns return `pending`. Runtime applies
them after active turns finish; subsequent tool discovery reports the connection
health and real tool names. Saving a configuration or testing a separate MCP
client does not establish that CardBush has connected to the server.

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
desktop. A second `observe` call targeting one exact HWND returns that window's
screenshot as a standard MCP `image` content block and issues a one-use
`state_id`. `include_text: true` adds bounded UI Automation elements (80 by
default, with a 10,000-character element budget). `include_screenshot: false`
requires text evidence. State and window identity precede the tree in the output.
Every existing-window action must present the same
HWND and state ID. The state expires after 30 seconds, is consumed before acting,
and becomes stale whenever another Turn changes the shared desktop. Semantic element actions (`click` by
index, `invoke`, and `set_value`) are preferred because they do not normally move
the pointer; window-relative SendInput remains a guarded fallback.

Observed elements expose `supported_actions`. Semantic clicks require Invoke,
Toggle, SelectionItem or ExpandCollapse; writable Value/RangeValue supports
`set_value`, which replaces the entire value. Value/Text alone does not make an
editor clickable. Unsupported semantic actions fail before launching a native
action or presenting an action pointer, and still consume the observation token.

`open_app` uses an existing working directory and performs window enumeration
before launch plus a bounded 1.5-second check afterward in the same PowerShell
process. Its `window_check` distinguishes newly observed matching windows,
existing candidates and an unconfirmed result. Matching is by launch PID or exact
process name, never merely by an unrelated new window. Candidates are not proof
of application readiness; the caller must observe the exact HWND before input.
Shell handoffs can reuse a process or delay a window beyond the check. An
unconfirmed result must not trigger automatic relaunch.

Native PowerShell calls launch a fixed-size bootstrap and deliver one complete
UTF-8 script as a Base64 line over standard input. Large scripts and payloads
never enter the process command line or per-value environment block. Request
parameters use script-scoped variables; even assigning large values to
`$env` inside an already-running process would hit the Windows size limit. Native C#
libraries are precompiled into `packages/cardbush-apps-mcp/dist/native` during a
Windows build. Packages built elsewhere compile missing immutable libraries
once into the local user cache. Library names include source and reference
hashes; changed native code cannot silently reuse an old library. Each request
still starts a process and exits after completion; no resident executor is added.

PowerShell failures retain bounded readable diagnostics and decode CLIXML error
records, omitting progress XML and encoded commands. Timeouts explicitly leave
the action outcome uncertain; cancellation remains cancellation.

Input/window actions default to `observe_after: true`. They perform one action,
release the active input lease, wait a bounded `settle_ms` (default 120, maximum
1000), and return `output.observation` with a new one-use state. This is a sample
after a bounded delay, not a claim that asynchronous application work has finished.
No recursive tool call, model-driven polling or automatic action replay is used.
The action and observation normally share one short-lived process. An ACK
handshake lets Node record dispatch and release the active input lease before
the worker proceeds to observation. Foreground changes during input can still
stop that worker and require a separate recovery capture. Cancellation and
failed capture never replay the acknowledged action.
If observation fails after a dispatch ACK, the ACK remains `execution: dispatched`
and the observation has an error and no state token. `observe_after: false` retains
explicit observe/action operation. `open_app` keeps its launch-specific contract.

`clipboard` accepts exactly one of `text` or `files`, bound to a fresh HWND/state.
Files must be existing absolute host-side paths; directories/device paths are
rejected before native dispatch. Native code rechecks the target and file list,
writes Unicode text or CF_HDROP with a copy drop effect, then verifies clipboard
contents before acknowledging. Nothing is automatically pasted or sent. The
following Ctrl+V uses a new observation/state. Successful clipboard writes do
not count as failed visual transitions, but repeated-action and takeover guards
still apply. Clipboard contents are not included in the acknowledgement.

Window observations support `region`, integer `scale` (1–3), and optional `grid`.
Only the delivered image is cropped/scaled; the full-window progress signature
is unchanged. `image` returns origin, source/output dimensions and scale, with
input/UIA coordinates remaining window-relative. Grid labels use full-window
pixels. A post-action crop invalidated by a popup or changed bounds falls back
to the full target and reports `region_reset`; a bad explicit crop is rejected.
Output is capped at 16 megapixels and 8192 pixels per dimension before allocation.

Top-level `timings` reports host-side `total_ms`, `process_count`,
`process_start_ms`, `initialization_ms`, `compile_ms`, `input_ms`,
`screenshot_ms`, `uia_ms`, and `settle_ms`. Startup is measured until PowerShell
reaches the bootstrap; initialization includes native/managed assembly loading.
Total also includes validation, control presentation and other host overhead,
so the phase fields are not an exhaustive sum. Model inference and network
waiting are outside these measurements. Failed calls retain available timings.

Progress uses an internal 128×128 visual signature with local tile comparison
near the action, plus query-independent focused-control evidence. A changed
word must not disappear into a whole-window average; caret blinking and minor
sampling noise do not qualify. Baselines belong to an exact PID/HWND. Discovery,
desktop screenshots, another target, or changing UIA filters cannot reset a
pending action's progress counter. Only verified same-target evidence or an
automatically verified owner/popup transition can establish progress.

Different preparatory actions can proceed for four unverified dispatches, so a
focus/type/Enter sequence is not stopped after two steps. `progress_unverified`
then requires one explicit same-target review and permits one different
corrective action. If it still cannot establish progress, `policy_blocked`
latches desktop control off for the turn. Repeated identical dispatches and
uncertain failures retain tighter limits. `observation_required` is recoverable;
terminal blocks cannot be cleared by observing a new window or calling finish.
Passive observations are bounded to six between actions, including query pages.

UIA scans up to 5000 descendants before selecting results, prioritizing focused
controls, Edit/ComboBox and buttons over large file lists. `element_query` filters
by case-insensitive name substring, exact automation ID/type, and/or focused
state before result limits; filters combine with AND. `element_offset` continues
from `accessibility.next_offset`, including a cutoff at the 10,000-character
model response budget. Results report matched/returned counts and a scan limit
separately. Returned indexes remain bound to native runtime IDs and the new
one-use state; previous pages' state tokens are invalidated. Focus evidence is
collected independently of returned pages, including screenshot-only captures.

Control notices distinguish physical mouse/keyboard activity (`user_takeover`),
explicit Escape/Stop (`user_stopped`), foreground transitions (`window_changed`),
target destruction (`window_unavailable`) and worker/lease failures. Only real
input increments the takeover budget; Stop/Escape and terminal guard failures
latch a stop for the turn. Our pointer movement and button/key events all carry the same
SendInput tag, including virtual-desktop coordinates on negative-origin monitors.
Foreground loss still blocks remaining input immediately. Errors report
`execution: not_dispatched | dispatched | unknown` and recovery guidance; unknown
means partial effects are possible.

Post-action capture may follow a verified owned foreground popup or the observed
owner of a closing popup, checking process identity as well as OS ownership.
The observation reports `requested_hwnd`, `target_relation`, owner HWND and the
foreground relationship. Same-process siblings never qualify merely by PID.
Discovery includes untitled owned/foreground windows. Capture rechecks HWND,
process and bounds; a foreground change during capture prevents state issuance.

Images use the existing generic MCP image-delivery pipeline and immutable image
store. No private Computer Use injection route is required. UI file artifacts
remain available, with duplicate model injection disabled. Delivery failures are
visible and do not imply an action failed. The MCP client removes a JSON text
block only when it is an exact semantic duplicate of `structuredContent`; prose,
distinct JSON and images are preserved, as is the full native execution journal.

Observation never activates a background window. Target observations report
`is_foreground`; `actionable` means input is ready in the foreground, while
`window_action_available` permits window operations with the fresh state ID.
For a background target, call `window` / `activate`, then inspect its returned
observation before sending input. Activation validates the observed HWND, process and bounds
directly, including secondary application windows, and fails if Windows does not
actually bring the target forward. Focus changes count as observation progress.

State and presentation rejections before target dispatch do not count as
unchanged action cycles. They retain a same-action retry limit and a separate
budget of six preflight failures, so a different corrective action remains
possible without allowing an endless invalid-action loop. Failures after target
dispatch remain conservatively counted because input may have partially run.
User takeover, explicit stop and one-use observation checks still apply.

Presentation lifetime is independent of permission to send input. Physical
takeover, foreground loss and recoverable failures retain the same window child
surfaces, showing paused or waiting status instead of tearing down the border.
Only the action pointer disappears between actions. Background clipping is owned
by the parent window; Stop/Escape, finish, cancellation, target destruction and
the existing worker/idle lease cleanup still end presentation.

Capture masks only tagged CardBush child surfaces around PrintWindow or the
desktop pixel copy. Startup, image encoding and UIA reading leave them visible.
Capture restoration checks the active marker so it cannot resurrect surfaces
after Stop/finish; final cleanup also clears masks left by a terminated capture.
UIA excludes the tagged surfaces. The desktop operation lease remains held until
the awaited observation completes, including failures and cleanup.

Regression coverage includes long-script transport, Unicode, each production
input action's native target validation, cancellation and spawn failures in the
Windows unit tests. It also includes the Apps MCP unit suite and the opt-in Windows
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

LF, CRLF and CR in `type` each dispatch one Enter key pair, preserving blank lines
without doubling Windows line endings. Other text retains Unicode/surrogate-pair
handling and the existing per-character foreground checks. Enter can execute or
submit in some applications, which is documented in the tool schema and skill.

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

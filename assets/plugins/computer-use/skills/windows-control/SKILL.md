---
name: windows-control
description: Control or inspect native Windows desktop applications through the guarded Computer Use capability when no dedicated app, file, shell, or browser interface can complete the task. Use for native window focus, screenshots, clicks, typing, shortcuts, scrolling, and dragging; not for browser-page automation or terminal work. 当任务必须直接操作 Windows 原生桌面应用且专用接口无法完成时使用；不用于网页自动化或终端任务。
---

# Windows Control

Use `computer_use` only for visible native Windows UI as the final fallback. It shares the user's interactive desktop, so keep each interaction short, observable, and easy to stop. CardBush yields when it detects user activity and normally restores the pointer after mouse actions; this is cooperative control, not a separate Windows session.

## Route Before Acting

- Prefer a dedicated app connector or API when one can complete the request.
- Prefer filesystem and terminal tools for files, scripts, processes, and command-line workflows.
- Prefer Chrome or browser tools for webpage content and browser-tab automation.
- Use this Skill when the remaining work genuinely requires a native desktop window.

## Safe Workflow

1. Identify the intended application and target state.
2. Call `observe` without a selector only to discover available windows. This discovery step intentionally does not capture the full desktop.
3. Choose exactly one returned window, then call `observe` again with its exact `hwnd`. This returns a window screenshot, accessibility elements, and a one-use `state_id`.
4. Check each element's `supported_actions` before using `click` with `element_index`, `invoke`, or `set_value`. Semantic click/invoke requires Invoke, Toggle, SelectionItem, or ExpandCollapse; Value/Text alone does not support clicking. `set_value` replaces the entire value and requires writable Value or RangeValue. To focus a text editor without replacing content, use an observed window-relative coordinate.
5. Pass the returned `state_id` and `hwnd` to the next action within 30 seconds. One action consumes the state. Never reuse a state, element index, or coordinate after any action, user input, or another session changes the desktop.
6. Wait for the visible state to settle, then observe the exact window again before the next dependent action.
7. Verify the requested result in the UI before claiming success.
8. Call `computer_use` with `action: "finish"` when desktop work is complete, abandoned, or handed back to the user. This releases the plugin's window presentation; it does not cancel the conversation. Do not omit it while switching to another tool route or giving the final answer.

## Window-scoped presentation

The plugin owns a thin cyan border, a named CardBush action pointer and a stop
button inside the target window. It keeps the border stable between actions and
hides the pointer while waiting. The pointer denotes an observed action target,
not the user's system cursor; physical-input operations still share system input.
No desktop-wide theme or mouse cursor replacement is performed.

User input pauses desktop actions. Resume only after a fresh observation and an
idle user; do not repeatedly retry a pause. The window's Stop button or Escape
ends desktop control for this turn. Never work around a stop using another tool.
The plugin hides its surfaces during screenshots, on foreground loss, and on
minimize. `finish`, request cancellation, target destruction, helper disconnection
and a two-minute idle limit clean up the presentation. The idle limit is a local
lease expiry, not evidence that the model turn completed.

For a requested desktop or native-window screenshot, use `screenshot` directly and return the resulting image artifact. A saved path by itself is not evidence that the pixels were inspected.

## Launching and typing

Discover existing windows before `open_app`. Its `dispatched` flag means a launch
request was sent, not that the application is ready. Inspect `window_check`:
`new_window_observed` identifies a newly observed matching window;
`existing_window_candidate` may be an existing instance reused by the application;
`unconfirmed` means no matching window was confirmed within the bounded check.
Candidates include the match basis and whether the same HWND/process existed
before launch. Always observe the exact candidate HWND before input. If no window
is confirmed, discover windows rather than launching again blindly.

For demonstrations, use a verified empty editor window or a new empty tab. An
application may reuse a process or window; never assume `open_app` creates a clean
document, and never type demo content into an existing user document.

`type` sends Unicode text and converts LF (`\n`), CRLF (`\r\n`), and CR (`\r`)
to one Enter each, preserving blank lines. In a terminal or submit-on-Enter field,
these line breaks can execute or submit, so only use multiline input when that
effect is intended. Use `key` for other shortcuts. Input acknowledgements still
require a subsequent observation to verify the application result.

## Safety Boundaries

- Never send input without a fresh target-specific `state_id` and exact `hwnd`.
- If the foreground application changes or CardBush yields to user input, do not immediately retry. Wait, observe once, and continue only if the target is unambiguous.
- Treat runtime permission prompts, blocked results, and the pointer failsafe as authoritative. Do not retry a blocked action or bypass the policy.
- Do not use `Alt+Tab` to guess the target window.
- Before an externally visible or destructive action such as submit, send, delete, close, or overwrite, confirm it is within the user's request and current permission scope.
- Never repeat the same action more than once against an unchanged screen. After the second unchanged result, stop and report the blocker or switch to a dedicated interface.
- Observe the exact window before every input action: each action consumes its one-use state, even when the screen appears unchanged. Keep retries bounded.

## Coordinate Fallback

Coordinates returned by a target-specific observation are relative to the captured window, not the desktop. `click`, `scroll`, and `drag` reject stale window bounds. If a window moved, resized, was covered, or the state token was consumed, observe it again instead of adjusting old coordinates.

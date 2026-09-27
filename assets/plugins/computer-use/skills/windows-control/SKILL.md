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
- For native mouse/keyboard input and desktop clipboard preparation, discover
  `computer_use` first. File preparation may use normal file/terminal tools;
  do not replace desktop control with ad-hoc terminal key/mouse scripts when
  this capability can perform it.

## Safe Workflow

Read these instructions once. If `run_skill` already supplied them, do not also
read the same SKILL.md through a file tool (or vice versa). Retain the relevant
workflow and recovery rules in the conversation summary after compaction.

1. Identify the intended application and target state.
2. Call `observe` without a selector only to discover available windows. This discovery step intentionally does not capture the full desktop.
3. Choose exactly one returned window, then call `observe` with its exact `hwnd`. This returns the screenshot directly as an MCP image and a one-use `state_id`. Enable `include_text: true` when you need accessibility elements, text values or semantic actions. For text-only inspection, use `include_text: true, include_screenshot: false`.
4. Check each element's `supported_actions` before using `click` with `element_index`, `invoke`, or `set_value`. Semantic click/invoke requires Invoke, Toggle, SelectionItem, or ExpandCollapse; Value/Text alone does not support clicking. `set_value` replaces the entire value and requires writable Value or RangeValue. To focus a text editor without replacing content, use an observed window-relative coordinate.
5. Pass the returned `state_id` and `hwnd` to the next action within 30 seconds. One action consumes the state. Never reuse a state, element index, or coordinate after any action, user input, or another session changes the desktop.
6. Window/input actions default to `observe_after: true`: after a bounded delay (120 ms by default, `settle_ms` up to 1000), they return `output.observation` with a fresh screenshot, HWND and state. Inspect this result and use its state for the next action. An extra `observe` is only needed if the returned observation is missing, expired or still transitional. Keep observation options on the action when you also need UIA text. `observe_after: false` requires an explicit observation before further input.
7. Verify the requested result in the UI before claiming success.
8. Call `computer_use` with `action: "finish"` when desktop work is complete, abandoned, or permanently handed back to the user. This releases the plugin's window presentation; it does not cancel the conversation. Do not finish between actions, while reasoning, during a recoverable error or temporary user takeover. Do not omit it when leaving desktop work for another tool route or giving the final answer.

Report meaningful milestones, verification or blockers to the user, rather than
narrating each click. Reuse the action's returned observation and image instead
of recapturing, rereading or reinjecting the same evidence.

## Finding controls

With `include_text: true`, focused controls, text inputs and buttons precede
large lists. If a needed control is missing, query before increasing the limit:
`element_query: { control_type: "Edit" }`, `{ name: "文件名" }`,
`{ automation_id: "1148" }` or `{ focused: true }`. Names use a case-insensitive
substring; IDs and types use an exact case-insensitive match; combined filters
use AND. An ID must come from observed UI, not a guess.

For broader inspection, continue with `element_offset` equal to
`accessibility.next_offset`, keeping the query unchanged. This pages past both
the element count and response-size limits. Every observation replaces the
state and element indexes; use controls from the latest result for actions.
The tree can change between pages. Do not page repeatedly just to wait for UI
readiness. If `scan_truncated` is true, narrow the visible UI instead.

## Window-scoped presentation

The plugin owns a thin cyan border, a named CardBush action pointer and a stop
button inside the target window. It keeps the border stable between actions and
hides the pointer while waiting. The pointer denotes an observed action target,
not the user's system cursor; physical-input operations still share system input.
No desktop-wide theme or mouse cursor replacement is performed.

Physical user input pauses desktop actions (`user_takeover`). Resume only after a
fresh observation and an idle user; do not repeatedly retry or sleep-poll a pause.
If the user is still active, return control or use the conversation's user-input
mechanism; terminal sleeps and repeated observation are not a resume signal.
The border and badge remain attached during takeover, waiting and recoverable
errors; only the status text changes and the action pointer disappears. A retained
badge does not mean input is permitted. Resume reuses the same window surfaces.
A foreground-window change alone is `window_changed`, not evidence of user input.
The window's Stop button or Escape (`user_stopped`)
ends desktop control for this turn. Never work around a stop using another tool.
Background windows retain their child surfaces, naturally clipped behind other
applications. Minimize hides them with the parent. Screenshots mask the surfaces
only for the actual pixel capture, not process startup or accessibility reading;
they are excluded from both image and accessibility evidence.
`finish`, request cancellation, target destruction, helper disconnection
and a two-minute idle limit clean up the presentation. The idle limit is a local
lease expiry, not evidence that the model turn completed.

For a requested desktop or native-window screenshot, use `screenshot` directly and return the resulting image artifact. A saved path by itself is not evidence that the pixels were inspected.

## Launching and typing

For clipboard preparation, use `action: "clipboard"` with the current `hwnd`
and `state_id`, and exactly one of `text` or `files`. File entries must be
absolute paths to existing files on the Windows host. The action copies a
verified text value or CF_HDROP file list; it never cuts, pastes, presses Enter
or sends a message. Text line breaks remain literal clipboard data.
Inspect its returned observation, focus the intended input if needed, and use
a separate `key` action with `keys: ["ctrl", "v"]`. Verify the pasted content
or attachment before a user-authorized send. Do not blindly replace a clipboard
failure with terminal clipboard commands.

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
require checking the returned observation to verify the application result.

## Popups and recovery

After an action opens a popup, the returned observation can follow it only when
the OS owner relationship and process identity match the observed target. Check
`target_relation` (`owned_popup` or `owner_window`) and use the returned HWND;
coordinates from the parent do not apply to the popup. Unnamed owned windows are
also discoverable. Same-process sibling windows are not automatically trusted.
For an unrelated foreground or an unrecognized dialog, inspect the reported
window context and select/observe the intended window explicitly. Do not assume
an emoji popup is a file dialog or reactivate the parent blindly.

Read `execution` on results and errors: `not_dispatched` means no target execution
was started; `dispatched` acknowledges input, not task completion; `unknown` can
mean partial input. A foreground transition can interrupt an action after its
click already opened a dialog. Inspect its recovery observation rather than
repeating the click. If capture/image delivery fails after input, the input
acknowledgement is retained: recover the observation, never replay a send,
upload or other action merely to obtain its screenshot. A file path is not visual
evidence; also check the Runtime image-delivery receipt if images are unavailable.

`observation_required` is recoverable with one fresh target observation.
`progress_unverified` means the latest attempted input was not dispatched:
observe the same target once, inspect the result, and choose one different
corrective action if justified. If that still has no verified progress, stop.
`policy_blocked` is terminal for this turn: finish and report the blocker.
Changing window, observation mode or calling finish does not clear it. Never
replace a blocked Enter with a newline in `type`, or use another input API to
evade a block. Normal focus → type → Enter can use each action's automatic
observation without extra polling.

## Safety Boundaries

- Never send input without a fresh target-specific `state_id` and exact `hwnd`.
- If the foreground changes, inspect the returned observation and relationship before continuing. If the user takes over, let them finish before observing again. These are different conditions; do not invent user activity from a popup.
- Treat runtime permission prompts, blocked results, and the pointer failsafe as authoritative. Do not retry a blocked action or bypass the policy.
- Do not use `Alt+Tab` to guess the target window.
- Before an externally visible or destructive action such as submit, send, delete, close, or overwrite, confirm it is within the user's request and current permission scope.
- Never repeat the same action more than once against an unchanged screen. After the second unchanged result, stop and report the blocker; do not switch interfaces to bypass an execution block.
- Use a fresh observation before every input action, including the observation returned by the preceding action. Each action consumes its one-use state, even when the screen appears unchanged. Keep retries bounded.

## Coordinate Fallback

Coordinates returned by a target-specific observation are relative to the captured window, not the desktop. `click`, `scroll`, and `drag` reject stale window bounds. If a window moved, resized, was covered, or the state token was consumed, observe it again instead of adjusting old coordinates.

For small or dense controls, observe the exact HWND with
`region: { x, y, width, height }` in original window pixels and optional
`scale: 2` (integer 1–3). A larger image does not create new source detail.
Input and UIA coordinates still use the full window. Convert a point in the
returned image with `window_x = image.origin.x + image_x / image.scale` and
the equivalent formula for y. Optional `grid: true` labels already show full
window coordinates; clean images remain the default. If an action opens an
owned popup or invalidates the requested crop, `image.region_reset` reports a
full-window fallback. Always use the actual returned origin, scale and HWND.

Results include host-side `timings` for process startup, native initialization,
compilation, input, capture, UIA and bounded settling, plus total duration and
process count. These do not include model inference/network waiting. Workers
start on demand and exit after the request; compiled libraries are reused on
disk. This does not enable action macros or change the one-action state rule.

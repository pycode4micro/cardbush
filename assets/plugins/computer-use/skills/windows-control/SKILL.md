---
name: windows-control
description: Control or inspect native Windows desktop applications through the guarded Computer Use capability when no dedicated app, file, shell, or browser interface can complete the task. Use for native window focus, screenshots, clicks, typing, shortcuts, scrolling, and dragging; not for browser-page automation or terminal work. 当任务必须直接操作 Windows 原生桌面应用且专用接口无法完成时使用；不用于网页自动化或终端任务。
---

# Windows Control

Use `computer_use` only for visible native Windows UI. It may occupy the user's mouse or keyboard, so keep each interaction small, observable, and easy to stop.

## Route Before Acting

- Prefer a dedicated app connector or API when one can complete the request.
- Prefer filesystem and terminal tools for files, scripts, processes, and command-line workflows.
- Prefer Chrome or browser tools for webpage content and browser-tab automation.
- Use this Skill when the remaining work genuinely requires a native desktop window.

## Safe Workflow

1. Identify the intended application and target state.
2. Use `observe` before input when the foreground window or coordinates are uncertain.
3. Activate a known window by an exact handle or distinctive title when possible.
4. Perform the smallest useful `click`, `type`, `key`, `scroll`, or `drag` action.
5. Wait for the visible state to settle, then observe again before the next dependent action.
6. Verify the requested result in the UI before claiming success.

For a requested desktop or native-window screenshot, use `screenshot` directly and return the resulting image artifact. A saved path by itself is not evidence that the pixels were inspected.

## Safety Boundaries

- Never send input to an unfocused or uncertain window.
- If the foreground application changes or user input makes the state uncertain, stop and observe again before continuing.
- Treat runtime permission prompts, blocked results, and the pointer failsafe as authoritative. Do not retry a blocked action or bypass the policy.
- Do not use `Alt+Tab` to guess the target window.
- Before an externally visible or destructive action such as submit, send, delete, close, or overwrite, confirm it is within the user's request and current permission scope.
- Avoid long unattended action chains. Re-check the desktop after every state-changing step.

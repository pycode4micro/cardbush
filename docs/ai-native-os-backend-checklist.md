# CardBush OS Agent Backend Checklist

BushServer only owns Agent behavior. Electron owns the OS interface and direct Windows integration, including application discovery, process state, window presentation, file browsing, wallpaper, taskbar behavior, controller input, and nine-key input.

## Implementation status

Status: **waiting for backend implementation**. The frontend and Electron desktop shell continue independently.

- [ ] Capability flags and OS metadata normalization
- [ ] Read-only desktop Agent tools
- [ ] Application/window Agent actions
- [ ] File Agent actions with audit and undo
- [ ] Visual capture and selected-window input
- [ ] Trusted application installation planning

## 1. Capability discovery

Expose these optional flags from `GET /v1/capabilities`:

- `desktop_agent`
- `desktop_agent_tools`
- `desktop_agent_events`
- `desktop_agent_visual_input`

The frontend must continue to work as a local desktop shell when these flags are unavailable. These flags only determine whether conversation can operate the desktop through the Agent.

## 2. Chat metadata

OS conversations send the existing chat request with:

```json
{
  "metadata": {
    "os_mode_enabled": true,
    "runtime_mode": "desktop_os",
    "workspace_mode": "desktop",
    "permission_mode": "all_free",
    "reasoning_level": "max"
  }
}
```

Requirements:

- OS mode must be explicit and session-stable.
- Ordinary project/chat sessions must not inherit OS permissions.
- `all_free` allows broad local execution but does not bypass authentication, auditing, confirmation policy, or non-overridable safety rules.

## 3. Agent tool surface

Provide a small generic tool set. Exact names may differ, but the semantics should remain stable:

- `desktop_state`: return a redacted summary of active application, visible windows, and selected desktop context.
- `desktop_app`: `list | launch | focus | close` using stable application IDs.
- `desktop_window`: `list | focus | minimize | maximize | close` using stable window IDs.
- `desktop_files`: bounded `list | search | inspect` without returning file contents by default.
- `desktop_file_action`: preview and execute `create | copy | move | rename | trash | restore | open`.
- `desktop_visual`: capture a user-visible screenshot only when visual input is enabled.
- `desktop_input`: pointer/keyboard interaction against an explicitly selected window.
- `desktop_appearance`: read or change wallpaper/theme with an undo snapshot.
- `desktop_app_catalog`: search trusted package catalogs and prepare an install plan.

Do not create separate REST resources for every OS object. These are Agent tools invoked inside the existing Agent loop.

## 4. Common tool envelope

Every desktop tool result should follow one compact envelope:

```json
{
  "ok": true,
  "action": "focus",
  "target": { "id": "window_...", "kind": "window", "label": "Visual Studio Code" },
  "summary": "Focused Visual Studio Code",
  "requires_confirmation": false,
  "audit_id": "audit_...",
  "undo_token": null,
  "data": {}
}
```

Requirements:

- Stable IDs, never titles or paths alone.
- Viewer-safe summaries; redact secrets, browser storage, tokens, and sensitive text.
- Structured error codes, including `not_found`, `stale_target`, `permission_denied`, `confirmation_required`, `action_failed`, and `unsupported`.
- Mutations accept an `idempotency_key`.
- Reversible mutations return an `undo_token`.

## 5. Confirmation boundary

The Agent may read bounded desktop state without confirmation. It must request explicit confirmation before:

- Installing or uninstalling software.
- Deleting data beyond moving it to the recycle bin.
- Sending messages, submitting forms, purchasing, publishing, or changing accounts.
- Entering credentials or transmitting sensitive data.
- Broad file operations or actions outside the user-visible task scope.

The backend should use the existing `interactive_request` flow. The frontend should not implement a second confirmation protocol for OS mode.

## 6. Stream events

Use the existing chat SSE stream. Tool calls continue to emit `tool`; optionally add:

- `desktop_action_started`
- `desktop_action_progress`
- `desktop_action_completed`
- `desktop_action_failed`

Each event needs `turn_id`, `action_id`, `tool_name`, timestamp, a safe summary, and `audit_id` when available. Do not stream raw screenshots or file contents unless the active tool explicitly requested them.

## 7. Frontend-owned responsibilities

BushServer must not implement or persist:

- OS layout, taskbar, control center, wallpaper rendering, or animations.
- Installed-application icons or live process polling for UI.
- File-manager UI state, selection, sorting, or navigation history.
- Gamepad mapping, focus navigation, or nine-key input.
- Electron startup, fullscreen behavior, Windows taskbar restoration, or crash recovery.
- A duplicate semantic file database for the first version.

## 8. First backend implementation order

1. Capability flags and OS chat metadata normalization.
2. Read-only `desktop_state`, app/window listing, and bounded file listing/search.
3. Application launch/focus and file open actions.
4. File mutation preview, confirmation, audit, and undo.
5. Visual screenshot plus selected-window input tools.
6. Trusted application catalog search and confirmed installation.

The frontend can advance independently through Electron IPC. Backend work is only required when the Agent itself must perform those operations from conversation.

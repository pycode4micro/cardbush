# Switch a conversation's workspace

[English](CONVERSATION_WORKSPACE_SWITCH.en.md) · [简体中文](CONVERSATION_WORKSPACE_SWITCH.md)

Switch an existing conversation's project through its workspace button or sidebar context menu. Drag it onto a project to switch directly, or onto Recents to use its independent workspace. Pinned conversations stay pinned. Dragging into the composer still creates a conversation reference.

Switching preserves the conversation ID, messages and tool history. It does not move, copy or delete files in the original directory. Later turns use the new directory and reread its context. A different project gets a new Git baseline; old workspace checkpoints cannot revert the new workspace, and old file links still target the original files.

The conversation, subtasks and workspace terminal must be idle, with queued messages handled. Other independent conversations may keep running. Missing or archived projects are not valid UI targets. Review and apply worktree changes as needed, then discard the independent worktree before switching; switching does not silently discard it. Incomplete version checkpoints must be completed first.

`runtime.switch_workspace` updates the Runtime binding and conversation project metadata together. Ordinary metadata edits still cannot rebind a managed workspace. The UI changes ownership only after success; failures preserve the current display and report an error.

Validation:

- Build `@cardbush/bush-protocol` and `@cardbush/bush-runtime`, then run `node --test packages/bush-runtime/test/workspaceSwitch.test.mjs`.
- Run `scripts/test-welcome-ui.cjs` with Electron. It uses isolated offscreen windows and mock conversations, without model calls or user data.
- Run `node --test packages/bush-runtime/test/taskWorkspace.test.mjs packages/bush-runtime/test/workspaceRevert.test.mjs`.

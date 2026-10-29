# SSH projects

[English](SSH_WORKSPACES.en.md) · [简体中文](SSH_WORKSPACES.md)

[中文](SSH_WORKSPACES.en.md) | [Documentation](README.md)

SSH workspaces are a desktop capability requiring neither a plugin nor a remote CardBush service.

## Entry points

- Settings → SSH connections saves hosts with SSH Agent, private-key-file or password authentication.
- Add project/new-conversation location selects local folders or saved SSH connections and remote directories. One connection can have multiple projects.
- Sidebar SSH project → Choose remote directory saves the destination. A conversation belonging to the original project switches its actual workspace; otherwise a new destination-project draft opens. Cancel/failure preserves the old binding.
- `@` selects a saved SSH connection; confirming a directory changes execution location and adds a reference.
- No standalone-workspace button remains above the conversation. Existing drag/drop between projects uses the shared workspace-switch mechanism.

Test/confirm the host fingerprint before first use. Changed saved fingerprints reject connection instead of silently trusting them. Passwords/key passphrases use Electron safeStorage; private-key files stay where the user selected them. Host/port/user changes require a new connection to avoid redirecting existing projects.

## Execution scope

Linux/POSIX and Windows OpenSSH are supported. POSIX terminals need `/bin/sh` and util-linux `setsid --wait`. Windows terminals require PowerShell 7 accessible as `pwsh`; Windows PowerShell 5 is unsupported. Both need SFTP, `rg` for content search, Git for Git operations and server atomic rename for replacing existing files. Dependencies are not installed automatically. Before executing, the host probes OS/shell and refuses mismatches without sending user commands. SFTP-only accounts retain nonterminal file access. Jump hosts, SSH-config import, interactive MFA and remote plugin execution are outside this entry's scope.

Project/session identity is `ssh://connectionID/directory`, preserving path case. The Agent loop stays on desktop: SSH is another execution environment, not removal of local capabilities. File/search/terminal tools accept:

- omitted/`workspace`: session default workspace;
- `local`: current Runtime host, using absolute paths and its native shell when the workspace is SSH;
- `ssh://connectionID/directory`: an explicit saved host/directory without changing project ownership. Omitted shell uses detection; POSIX supports `posix`, Windows supports `powershell`/`cmd`. Windows accepts `C:\Users\name` or `/C:/Users/name`; `/` is only the SFTP browsing root, not an execution directory.

For example, read a local absolute file with `environment: "local"`, then write via an explicit SSH environment. Choosing a host grants no path permission. `executionEnvironment` reports actual execution. Project Git status/branches/commit/push follow the selected project.

`search_skills` returns local resource paths with `environment: "local"`; use that environment for Skills/references. In a standalone Agent, local means the server, not its desktop client. Other plugins/tools retain their own declared environments. Direct remote projects have no local checkpoints, worktree copies or local undo. Local-only OS file-manager/rename actions reject remote paths; use remote file tools/terminal instead.

## References and review

- `remember_file`/`remember_source` accept absolute local paths or complete returned `ssh://connectionID/absolute/file` paths. Permission checks run on that host, never treating remote directories as local roots or falling back locally on failure.
- Remote `@` files retain SSH paths. Images are references, not fake local vision attachments. Relative Markdown/POSIX absolute links in SSH chats use that workspace; Windows absolute paths still refer locally.
- Inspector opens remote text/code/Markdown up to the first 2 MiB. Generic image/media reads cap at 8 MiB, avoiding unlimited downloads. Office/model formats requiring local converters have no SSH conversion integration yet.
- Source stores hashes/optional lines up to 2 MiB, metadata for larger files. Historical evidence retains its original version and indicates changed/unavailable files.
- `write_file`/`edit_file` record actual paths, line counts and diffs for review; internal diffs stay in execution logs rather than short model receipts. Paths preserve case while permissions/write locks compare using the remote platform's semantics.
- Reading `git diff`, statistics or history does not create new changes. Non-Git directories can review file-tool changes and show a normal no-branches state.
- SSH has no task undo or automatic capture of terminal/script changes. UI disables undo and Runtime rejects stray requests. Historical missing diffs cannot be reconstructed from counts.

## Runtime behavior

- Workspace changes keep history/drafts without moving files. Active Turns, background tools or remote terminals block switching.
- Connection failure never falls back locally or replays a command. A disconnected terminal may still have a remote process; reconnect and check.
- Editing requires that session's latest read SHA-256. Same-file writes serialize inside desktop and recheck before writing; other clients are outside this lock.
- Terminals isolate sessions/connections. `terminal_list` lists all session environments, optionally filtered. Poll/write/stop follow their original handle without repeating environment; conflicting explicit hosts fail. POSIX stop signals the process group with TERM then KILL if needed. Windows uses its owned Job Object. Unconfirmed stopping errors. Process ownership is neither a sandbox nor elevation.
- Exit attempts to stop known remote terminals and close connections. Externally started or deliberately detached services are not managed tasks.

## Verification

`npm run test:ssh` builds protocol/Runtime/main and exercises real loopback SSH handshakes with SFTP/process fixtures, without reading user SSH config or external hosts. `npm run test:ssh-ui` uses hidden Electron for connection/fingerprint/theme/narrow/browse/failure/switch/`@` flows. Verify a real server through the user's configured Test action.

`node scripts/run-app-views-test.mjs ssh-review` covers reference clicks, code preview, review and non-Git/undo states. Loopback checks also cover mixed-host evidence, revisions, case and read limits.

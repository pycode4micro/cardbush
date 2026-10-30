# Terminal CLI

[English](CLI.md) · [简体中文](CLI.zh-CN.md)

Install the [npm Agent + CLI package](NPM_AGENT.en.md), then run `cardbush` in your working directory. Chat runs locally; saved remote addresses and remote environment variables do not redirect it. `--local` remains a compatibility alias.

This guide describes current source. The worker commands and removal of remote chat selection require a new build; they are not part of the published npm 1.0.13.

## Models and local execution

No local connection token is required. The CLI shares supported app model, plugin, MCP, network and sandbox JSON settings, but stores its own sessions under `~/.cardbush/cli-agent`. Multiple local CLI windows share one private Runtime; a new window normally gets a new session.

If no model is configured, follow the displayed configuration path and example, save the file, and press Enter. `/settings` shows paths and reloads settings; `/model` selects a model and reasoning effort without changing the app's default. API-key models run without the app. ChatGPT account models reuse the app's local authorization bridge: keep the app signed in and running. See [model connections](MODEL_CONNECTIONS.en.md) and [SIWC](SIWC_INTEGRATION.md).

## Start and resume

```sh
cardbush
cardbush --resume
cardbush --resume SESSION_ID
cardbush --model MODEL_ID
cardbush --prompt "Summarize the files in this workspace"
cardbush --sessions
cardbush --version
```

`--resume` without an ID opens an interactive picker. It lists sessions across projects on the connected Runtime/Agent. A resumed session keeps its own workspace and restores its last submitted model and effort; `--model` explicitly overrides that selection. Sessions whose saved model is unavailable use the current default.

History shows user messages and final replies. It does not flood the terminal with old tool payloads; use `/tools --turn N` for those. One-shot or piped input keeps stdout limited to the new reply. Non-interactive resume selection requires an explicit ID; use `--sessions` to find one.

## Input and keyboard controls

| Action | Control |
| --- | --- |
| Send while idle | Enter |
| Queue the next turn while running | Enter |
| Guide the current task immediately | Ctrl+Enter, or `/steer TEXT` when the terminal cannot distinguish the key combination |
| Choose a suggestion | Up/Down; Enter confirms, Tab fills without submitting |
| Insert a file reference | Type `@`; quote paths containing spaces, for example `@"docs/my note.md"` |
| Stop the current task | Esc or Ctrl+C |
| Clear an idle draft | Esc |
| Exit when idle | Ctrl+C, `/quit` or `/exit` |

Long or multiline pastes are folded visually but submitted in full. Incoming responses preserve the draft. Approval prompts temporarily take over input and restore it afterwards. Approvals start on Deny; choose Allow once and press Enter to allow that operation. Piped mode stops with exit code 2 if confirmation is needed.

## Commands

| Command | Purpose |
| --- | --- |
| `/session [ID]`, `/new` | Switch to an existing session or start a new one. |
| `/model [ID]`, `/settings` | Select model/effort or inspect and reload configuration. |
| `/tools [number] [--turn N]` | Read tool names, arguments, outcomes and archived details. |
| `/artifact [number]` | List or open this turn's generated files; Tab selects and Enter opens. |
| `/source [number]` | Inspect recorded evidence and references. |
| `/plan` | Show the current plan. |
| `/habit [on\|off\|status]` | Manage this session's optional habit memory. |
| `/prediction [on\|off\|status]` | Manage this session's next-step predictions. |
| `/browser` | Inspect and manage browser connections. |
| `/logs` | Show the diagnostic log path. |
| `/shell [COMMAND]`, `!COMMAND` | Run a local shell command; exit the native shell to return to chat. |
| `/help`, `/quit`, `/exit` | Help and exit. |

Habit and prediction default to off in new sessions, persist on resume and are inherited by a fork. Finish or stop the current task before changing sessions, models, settings or running a local shell. During a task, `/exit` stops the observed task and this window's queued messages; other windows' queues remain intact.

Links are clickable in terminals that support them; in Windows Terminal, use Ctrl+click on an underlined link. `/artifact` is the fallback for file opening. Local artifacts open the original file. `/shell` runs on the CLI machine as the CLI user. Remote worker paths require an explicit authorized transfer; they are not local paths.

## Register a remote subagent worker

```sh
cardbush worker add --name Renderer --url https://agent.example.com --token-file /private/access-token
cardbush worker list
cardbush worker verify CONNECTION_ID
cardbush worker remove CONNECTION_ID
```

Ask your local Agent to save a subagent role for the returned connection and verified instance. It can then delegate, inspect, guide, answer or stop that child. The remote service keeps its own configuration and authority. See the [interaction protocol](SUBAGENT_REMOTE_PROTOCOL.md).

App and CLI on the same local profile share worker connections. `worker list/add/verify/remove` use the protected registry directly and do not start the full Agent Runtime. Old connections migrate without changing their IDs. A successful verification checks the remote service identity and protocol, not whether its independent model is configured. Configure a model on the worker before delegating real work.

Direct chat `--url` / `--token-file` options have been retired; legacy connection settings are ignored. `--project ID` chooses an existing local-host project. A CLI installed on a server is still a local CLI on that server, with its own session store; it does not attach to the independently running HTTP service.

The same package installs the service commands:

```sh
cardbush serve --background
cardbush serve --status
cardbush serve --stop
cardbush serve --help
```

`cardbush-agent` is an alias for the service entry point. Default service data is in `~/.cardbush/service`, separate from local CLI session data. Updating a desktop app does not update an npm service.

## Browser Use

Enable Browser Use, load its Chrome/Edge extension, and approve the first local connection in the CardBush extension flow. The app and local CLI share connections; external Chrome/Edge do not require the app, while integrated CardBush tabs do.

```text
/browser status
/browser retry
/browser pair chrome
/browser pair edge
```

Manual pairing is for explicit or remote connections. Remote Agents keep their own connections and cannot inherit local page authorization. After repeated failures, recovery pauses: `/browser retry` retries the host connector, while Connect in the extension retries the saved extension connection. A temporary disconnect does not require a new code. See [Browser Use](CORE_BROWSER_COMPUTER_USE.en.md).

## Diagnostics and updates

Replies use stdout; progress and prompts use stderr. Local diagnostic logs rotate under `logs/runtime.log` in the CLI data directory. Use `/tools` for execution failures and `/logs` for host diagnostics. Redact secrets and private content before sharing logs.

Update with `npm install -g cardbush@latest`, then open a new CLI. A source-linked command needs a fresh `npm run build:agent` after source changes. To remove a global installation use `npm uninstall -g cardbush`. See [installation troubleshooting](INSTALLATION.md) and [security boundaries](../SECURITY.md).

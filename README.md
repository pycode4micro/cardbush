# CardBush

**English** · [简体中文](README.zh-CN.md)

A desktop AI workspace for conversations, files, coding, automation and MCP plugins. Use the built-in local Agent, work in an SSH project, or connect to an independent Agent service over HTTPS or SSH. Local and remote conversations share the same interface; core local chat and command tools need no separate server or Python installation.

## Download

Source version: **1.0.0-beta.4**. The installers below become available when both platforms pass the tagged release workflow. Until publication completes, use the latest completed version on the [Releases page](https://github.com/pycode4micro/cardbush/releases).

| System | Download | Suitable computers |
| --- | --- | --- |
| Windows 11 | [Windows x64 installer (.exe)](https://github.com/pycode4micro/cardbush/releases/download/v1.0.0-beta.4/CardBush-1.0.0-beta.4-windows-x64.exe) | Intel / AMD 64-bit |
| Linux | [Linux x64 AppImage](https://github.com/pycode4micro/cardbush/releases/download/v1.0.0-beta.4/CardBush-1.0.0-beta.4-linux-x86_64.AppImage) | x86-64 desktop Linux; CI validates Ubuntu 22.04 |

[All releases and SHA-256 checksums](https://github.com/pycode4micro/cardbush/releases) · [Build and validation workflow](https://github.com/pycode4micro/cardbush/actions/workflows/desktop.yml)

Both packages use the same Beta 4 source tag. This update adds independent Agent services and SSH workspaces, an App Center, shared local/remote conversations and settings, command sandboxes, and improvements to tool execution and context recovery. See the [release notes](docs/releases/1.0.0-beta.4.md). Releases include SHA-256 checksums and packaged startup reports; a successful main-branch build alone does not publish a release.

Current development targets Windows 11 only (build 22000 or later), including Store MSIX packages and the Browser Use connector (Chrome / Edge). Older published downloads may have different requirements. There is no separate Intel/AMD or GPU edition. ARM64, 32-bit Windows, Windows 7/8/10 and macOS packages are not supported by the current Windows build. The Windows EXE release workflow requires a publisher signing certificate; ordinary CI builds produce unsigned development installers.

Store MSIX packages use a separate four-part version and are signed by Microsoft during certification. Locally test-signed copies must not be uploaded. See the [MSIX submission preparation](docs/MSIX_SUBMISSION_PREPARATION_2026-09-29.md) for the current candidate and review materials; preparing them does not mean certification has been submitted or approved.

### Install and start

**Windows EXE:** open the installer, choose an installation directory and launch CardBush. EXE uninstall retains local conversations and settings. MSIX installation and application data are managed by Windows; normal system uninstall removes package-owned data. Separately saved workspace files, browser profiles and manually installed extensions are preserved.

**Linux:** download the AppImage, allow it to execute, then run it:

```sh
chmod +x CardBush-1.0.0-beta.4-linux-x86_64.AppImage
./CardBush-1.0.0-beta.4-linux-x86_64.AppImage
```

AppImage needs FUSE 2 (on Ubuntu 22.04: `sudo apt install libfuse2`). If FUSE is unavailable, run with `APPIMAGE_EXTRACT_AND_RUN=1`. Chromium also requires a working sandbox; do not disable it as an installation workaround.

On first launch, open **App Center → Settings → Models** and configure a supported provider, model and API key. The settings environment selector chooses the local host or a connected Agent. Model usage is billed by your provider. Plugins may require their own dependencies or credentials; follow each plugin's installation instructions.

The model editor supports **OpenAI Responses, Chat Completions, and Anthropic Messages**, with custom HTTP headers and automatic per-conversation session headers for OpenCode Go. See [model connections](docs/MODEL_CONNECTIONS.md).

## What is included?

- Shared local/remote chat, streaming, projects, image attachments, previews, queued messages and in-turn guidance.
- An App Center for plugins, automation and settings, with draggable shortcuts, application links, Windows application shortcuts and `@` application references.
- File search and version-checked editing, batched MCP schema loading, searchable archived tool results and terminal completion notifications.
- **Ask for approval / Full access** permission modes, with separately managed Windows and Linux command sandboxes.
- Persistent sessions, subagents, automations, calendar views and optional offline Chinese/US display calendars.
- MCP plugins, skills, an integrated browser, conversation extraction and context recovery. Built-in skills include Agent deployment and Blender video previsualization.
- Page back/forward navigation, theme-aware tooltips and shortcuts, personalization and persistent usage statistics.

Open **Agents → +** to connect an independent service. The service owns its model configuration, credentials, projects, plugins and task queue; accepted tasks continue when the desktop disconnects. An **SSH project** instead keeps the Agent on the desktop and runs supported file/command operations on the selected SSH host. See [Agent services](docs/AGENT_SERVICES.md) and [SSH workspaces](docs/SSH_WORKSPACES.md).

App Center entries open actual pages or user-selected applications. Ordinary MCP connectors remain in plugin settings. An `@` reference supplies context to the Agent; it does not execute an application or grant permissions. See [App Center behavior](assets/skills/cardbush-docs/references/app-center.md).

Team workflows are a separate installable plugin, not part of the desktop bundle. See [Team plugin architecture](docs/TEAM_PLUGIN_EXTRACTION.md).

### Platform support

| Capability | Windows x64 | Linux x64 |
| --- | --- | --- |
| Chat, files, previews, MCP and integrated browser | Yes | Yes |
| Terminal commands | PowerShell / cmd | POSIX Shell |
| Bundled search | Native ripgrep | Native ripgrep |
| Command sandbox | AppContainer | bubblewrap, when supported by the host |
| Windows computer-use plugin | Yes | Unavailable |
| Browser Use connector (Chrome / Edge) | Yes | Unavailable; integrated browser remains available |
| Native process CPU / memory enforcement | Windows Job Objects | Not yet implemented |
| Managed process admission and owned-process cleanup | Yes | Yes |

Linux does not claim the same CPU/memory enforcement as Windows. External plugins remain separate programs with their own platform requirements. A remote service exposes its own capabilities, not those of the desktop connecting to it.

Sandbox settings detect the host environment; dependency installation requires a user click. An installed, available sandbox is enabled by default unless the user or administrator has disabled it. With the normal `auto` policy, **Ask for approval** isolates commands and requests additional access when needed; **Full access** uses ordinary processes. An administrator's `required` policy remains binding in either mode. The command sandbox does not cover every MCP, plugin or browser action. See [permissions](docs/PERMISSIONS.md) and [sandbox scope and limits](docs/EXECUTION_SANDBOX.md).

## Develop

Node.js **>=22.12** and npm **>=10** are required; CI uses Node.js 24. Build installers on their target operating system.

```sh
npm ci
npm run runtime-tools:install
npm run dev
```

```sh
npm run build
npm run typecheck
npm run test:release
npm run package:win     # Windows: signed NSIS installer; publisher certificate required
npm run package:linux   # Linux: AppImage
npm run smoke:packaged
```

On headless Linux, run desktop tests with `xvfb-run -a npm run test:release`. Outputs are in `release/`. `npm run test:release` requires a preceding build; it runs package tests, adversarial cases, platform contracts and Electron UI checks without repeatedly rebuilding each package. `npm run test:all` also runs the wider feature-specific checks. Provider tests use local mock HTTP servers; no live API key is needed.

For a headless Agent service, use `npm ci --ignore-scripts`, `npm run build:agent`, then `node dist-electron/agentServiceCli.mjs --data-dir /absolute/path/agent-data`. It runs under Node.js without launching Electron. Use a dedicated data directory and configure authentication and SSH/HTTPS access as described in the [deployment guide](docs/AGENT_SERVICES.md). Desktop installers do not deploy or update this service.

Electron downloads use the official source by default. An optional `ELECTRON_MIRROR` can be configured for your network. Repair an incomplete download with `npm run fix:electron`.

## Architecture and maintenance

| Directory | Responsibility |
| --- | --- |
| `packages/cardbush-platform` | Host capabilities, Shell resolution, executable discovery and native resource paths |
| `packages/bush-runtime` | Provider-independent Agent loop, tools, permissions and state |
| `packages/bush-product-agent` | Shared product instructions and turn-request construction |
| `packages/cardbush-product-host` | Shared model, plugin, MCP, sandbox and maintenance command contracts/configuration |
| `packages/bush-protocol` | Typed commands, events and IPC contracts |
| `packages/bush-provider-openai` | Responses, Chat Completions and Anthropic Messages transport |
| `packages/bush-mcp-client` | MCP transports and tool/resource integration |
| `packages/bush-runtime-electron` | Typed Runtime transport/client reused by desktop and Node hosts |
| `electron` | Desktop lifecycle, Utility Runtime host, headless Agent service and host adapters |
| `src` | Shared React conversation/settings UI and local/remote backend adapters |
| `scripts` | Development, regression tests, packaging and smoke checks |

Platform selection is centralized in `@cardbush/platform`; its browser-safe contracts and Node adapters are separate exports. The desktop hosts Runtime in an Electron utility process; the independent service hosts the same worker with Node.js. Product Host and backend adapters select the owner of configuration and operations. The conversation UI consumes shared Runtime events rather than maintaining a separate cloud transcript.

See the [architecture overview](docs/ARCHITECTURE.md), [cross-platform maintenance and release guide](docs/CROSS_PLATFORM_RELEASE.md), [tool interaction contracts](docs/TOOL_INTERACTION.md) and [bundled apps MCP](docs/host/CARDBUSH_APPS_MCP.md).

## Data and security

Local conversations, usage records and settings live under Electron's user-data directory. Each independent Agent stores its own data and credentials in its server data directory; switching environments does not copy them to another host. Local automation requires the desktop to be running; independent Agent queues and supported automation run while that service is running. Clearing transient caches does not reset recorded usage.

The renderer uses context isolation and no Node.js integration. Remote Agent access is authenticated and represents access to that instance, not a multi-tenant account system. Model providers and external plugins receive the data needed for their requested operations. File/tool permissions and OS command isolation are separate controls.

Do not attach credentials, raw conversation stores or unredacted logs to public issues.

## License

Original CardBush code is licensed under [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) and [bundled skill licensing](docs/BUNDLED_SKILL_LICENSES.md). Bundled dependencies and external plugins retain their respective licenses.

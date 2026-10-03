<p align="center">
  <img src="docs/assets/readme-hero.svg" width="100%" alt="CardBush — your workspace, your agent. Talk, build and automate from desktop to cloud." />
</p>

<p align="center">
  <a href="https://apps.microsoft.com/detail/9N7XNDD5WRGS"><img src="https://img.shields.io/badge/Windows-Microsoft_Store-7868D8?style=for-the-badge&amp;logo=windows&amp;logoColor=white" alt="Download for Windows from Microsoft Store" /></a>
  <a href="https://github.com/pycode4micro/cardbush/releases"><img src="https://img.shields.io/badge/Linux-AppImage-303342?style=for-the-badge&amp;logo=linux&amp;logoColor=white" alt="Linux AppImage releases" /></a>
  <a href="https://github.com/pycode4micro/cardbush/stargazers"><img src="https://img.shields.io/github/stars/pycode4micro/cardbush?style=for-the-badge&amp;label=Star&amp;color=303342" alt="Star CardBush on GitHub" /></a>
  <a href="https://github.com/pycode4micro"><img src="https://img.shields.io/badge/Follow-%40pycode4micro-303342?style=for-the-badge&amp;logo=github&amp;logoColor=white" alt="Follow pycode4micro on GitHub" /></a>
</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="#documentation">Documentation</a> · <a href="https://github.com/pycode4micro/cardbush/issues">Feedback</a></p>

# CardBush

**A personal AI workspace that turns conversations into action.** Chat by text or voice, work with files and browsers, arrange your own start page, and run tasks on your computer or an independent Agent service.

Bring your preferred model, connect tools through MCP and skills, and keep local and remote work in one interface. Core local chat and command tools need no separate server or Python installation.

If CardBush is useful to you, **[give it a star](https://github.com/pycode4micro/cardbush/stargazers)** or **[follow @pycode4micro](https://github.com/pycode4micro)** for development updates. Bug reports, ideas and contributions are welcome.

## Download

| System | Download | Suitable computers |
| --- | --- | --- |
| **Windows 11** | **[Get CardBush from Microsoft Store (MSIX)](https://apps.microsoft.com/detail/9N7XNDD5WRGS)** | Intel / AMD x64; build 22000 or later |
| Linux | [Get the AppImage from Releases](https://github.com/pycode4micro/cardbush/releases) | x86-64 desktop Linux; CI validates Ubuntu 22.04 |

[All releases and SHA-256 checksums](https://github.com/pycode4micro/cardbush/releases) · [Build and validation workflow](https://github.com/pycode4micro/cardbush/actions/workflows/desktop.yml)

This README describes source version **1.0.0-beta.5**. The Store listing and Releases page show the versions actually available; their feature sets may lag behind the main branch. MSIX has its own four-part version number. There are currently no macOS, ARM64 or 32-bit packages.

### Install and start

**Windows:** open the [Microsoft Store listing](https://apps.microsoft.com/detail/9N7XNDD5WRGS), install CardBush, then launch it from Start. Windows manages the MSIX package and its updates. Before uninstalling, back up any conversations or settings you want to keep; normal MSIX uninstall removes package-owned data.

**Linux:** download a published x86-64 AppImage, rename it to `CardBush.AppImage`, allow it to execute, then run it:

```sh
chmod +x CardBush.AppImage
./CardBush.AppImage
```

AppImage needs FUSE 2 (on Ubuntu 22.04: `sudo apt install libfuse2`). If FUSE is unavailable, run with `APPIMAGE_EXTRACT_AND_RUN=1`. Chromium also requires a working sandbox; do not disable it as an installation workaround.

On first launch, open **App Center → Settings → Models → Add model**:

- **API key:** configure your provider and choose OpenAI Responses, Chat Completions or Anthropic Messages. OpenRouter and OpenCode Go are supported. See [model connections](docs/MODEL_CONNECTIONS.md).
- **ChatGPT account:** on the local desktop, choose **ChatGPT · SIWC → Continue with ChatGPT**, authorize in the system browser, then select a model from your account's catalog. Availability depends on the account and service; local account credentials are not synced to remote Agents. See [SIWC setup and limits](docs/SIWC_INTEGRATION.md).

The settings environment selector chooses the local host or a connected Agent. Model usage follows your provider or authorized plan. Plugins may require separate dependencies or credentials.

## What is included?

| Make it yours | What you can do |
| --- | --- |
| **Text and voice** | Stream replies, attach images, queue messages and guide a running task. Click the empty composer's microphone to dictate; hold it to enter a voice conversation with spoken Agent replies. |
| **Your start page** | Arrange clocks, a calendar, conversation starters and either composer style. Import custom HTML components, drag and resize with alignment guides, and use theme-aware events and permitted actions. |
| **A browser workspace** | Save favorite pages, use multiple panes in Beta, and expand the right panel with a floating return/input capsule. |
| **Tools that act** | Search and edit files, run commands, use subagents, add MCP plugins and skills, and schedule automations. Choose Ask for approval or Full access. |
| **Local or remote** | Use the built-in Agent, an SSH project or an independent Agent service. Optionally give a personal Linux Agent its own graphical desktop, Computer Use and Browser Use. |
| **Continuity** | Persistent conversations, context recovery, searchable archived tool results and usage records. Habit memory and next-step predictions are optional and off by default. |

Voice uses speech recognition, the existing text Agent and speech synthesis. Only voice conversations read replies aloud automatically. **SenseVoice recognition and Qwen3-TTS CustomVoice speech are the recommended local options**, with separate female/male voices at a natural speaking rate. Models are optional, not preinstalled; Qwen uses your selected local model folder and Python environment. Windows speech and legacy Kokoro remain available. Windows x64 also offers an optional local voice lock: enroll your voice to reduce other speakers triggering messages or interrupting playback. See [voice setup, downloads and platform limits](docs/LOCAL_VOICE_MODELS.md).

Open **App Center → Components** to edit the new-conversation layout. Built-in component definitions stay available; custom HTML uses an isolated frame and explicitly granted actions. The calendar shows holidays and automation details on hover. See [components, layout and browser panes](docs/HTML_COMPONENTS_V1_2026-09-30.md).

Open **Agents → +** to connect an independent service. The service owns its model configuration, credentials, projects, plugins and task queue; accepted tasks continue when the desktop disconnects. An **SSH project** instead keeps the Agent on the desktop and runs supported file/command operations on the selected SSH host. See [Agent services](docs/AGENT_SERVICES.md) and [SSH workspaces](docs/SSH_WORKSPACES.md).

Remote deployment is **headless by default**. The optional [Docker desktop profile](deploy/agent/README.md) adds an isolated Linux desktop with a visible Chromium browser, desktop preview and user takeover. It is intended for personal Agents; ordinary service deployments do not need it.

App Center entries open actual pages or user-selected applications. Ordinary MCP connectors remain in plugin settings. An `@` reference supplies context to the Agent; it does not execute an application or grant permissions. See [App Center behavior](assets/skills/cardbush-docs/references/app-center.md).

Team workflows are a separate installable plugin, not part of the desktop bundle. See [Team plugin architecture](docs/TEAM_PLUGIN_EXTRACTION.md).

### Platform support

| Desktop app capability | Windows x64 | Linux x64 |
| --- | --- | --- |
| Chat, files, previews, MCP and integrated browser | Yes | Yes |
| Terminal commands | PowerShell / cmd | POSIX Shell |
| Bundled search | Native ripgrep | Native ripgrep |
| Command sandbox | AppContainer | bubblewrap, when supported by the host |
| Windows computer-use plugin | Yes | Unavailable |
| Browser Use connector (Chrome / Edge) | Yes | Unavailable; integrated browser remains available |
| Native process CPU / memory enforcement | Windows Job Objects | Not yet implemented |
| Managed process admission and owned-process cleanup | Yes | Yes |

The Windows Browser Use connector and the optional remote Linux desktop use different integrations. The Docker desktop profile supplies Linux Computer Use / Browser Use on the server; it does not make Windows-only plugins portable. Local voice platform limits are listed in the [voice guide](docs/LOCAL_VOICE_MODELS.md).

Linux does not claim the same CPU/memory enforcement as Windows. External plugins remain separate programs with their own platform requirements. A remote service exposes its own capabilities, not those of the desktop connecting to it.

Sandbox settings detect the host environment; dependency installation requires a user click. An installed, available sandbox is enabled by default unless the user or administrator has disabled it. With the normal `auto` policy, **Ask for approval** isolates commands and requests additional access when needed; **Full access** uses ordinary processes. An administrator's `required` policy remains binding in either mode. The command sandbox does not cover every MCP, plugin or browser action. See [permissions](docs/PERMISSIONS.md) and [sandbox scope and limits](docs/EXECUTION_SANDBOX.md).

## Documentation

| Start here | Guide |
| --- | --- |
| Connect a model | [Providers, protocols and OpenRouter](docs/MODEL_CONNECTIONS.md) · [ChatGPT / SIWC](docs/SIWC_INTEGRATION.md) |
| Set up voice | [Local speech recognition and voices](docs/LOCAL_VOICE_MODELS.md) |
| Customize your workspace | [HTML components, layout and browser panes](docs/HTML_COMPONENTS_V1_2026-09-30.md) · [App Center](assets/skills/cardbush-docs/references/app-center.md) |
| Run an Agent remotely | [Service deployment](docs/AGENT_SERVICES.md) · [Docker and optional Linux desktop](deploy/agent/README.md) · [SSH projects](docs/SSH_WORKSPACES.md) |
| Understand access | [Permissions](docs/PERMISSIONS.md) · [Command sandbox](docs/EXECUTION_SANDBOX.md) · [Computer Use / Browser Use](docs/CORE_BROWSER_COMPUTER_USE.md) |
| Contribute and release | [Architecture](docs/ARCHITECTURE.md) · [Cross-platform releases](docs/CROSS_PLATFORM_RELEASE.md) · [MSIX maintainer guide](docs/MSIX_STORE_RELEASE.md) |

Some detailed guides are currently in Chinese; both READMEs link to the same implementation references.

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
npm run package:msix    # Windows: Store package; follow the MSIX maintainer guide
npm run package:win     # Windows: signed NSIS installer; publisher certificate required
npm run package:linux   # Linux: AppImage
npm run smoke:packaged
```

On headless Linux, run desktop tests with `xvfb-run -a npm run test:release`. Outputs are in `release/`. `npm run test:release` requires a preceding build; it runs package tests, adversarial cases, platform contracts and Electron UI checks without repeatedly rebuilding each package. `npm run test:all` also runs the wider feature-specific checks. Provider tests use local mock HTTP servers; no live API key is needed.

For a headless Agent service, use `npm ci --ignore-scripts`, `npm run build:agent`, then `node dist-electron/agentServiceCli.mjs --data-dir /absolute/path/agent-data`. It runs under Node.js without launching Electron. Use a dedicated data directory and configure authentication and SSH/HTTPS access as described in the [deployment guide](docs/AGENT_SERVICES.md). For containers and the optional graphical desktop, follow the [Docker guide](deploy/agent/README.md). Desktop installers do not deploy or update this service.

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

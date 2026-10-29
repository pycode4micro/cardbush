<p align="center">
  <img src="docs/assets/readme-hero.svg" width="100%" alt="CardBush — your workspace, your agent. Talk, build and automate from desktop to cloud." />
</p>

<p align="center"><a href="https://apps.microsoft.com/detail/9N7XNDD5WRGS">Microsoft Store</a> · <a href="https://www.npmjs.com/package/cardbush">npm: Agent + CLI</a> · <a href="https://github.com/pycode4micro/cardbush/releases">Desktop releases</a></p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="docs/README.md">Documentation</a> · <a href="SECURITY.md">Security</a></p>

# CardBush

**A personal AI workspace that turns conversations into action.** Use your preferred model to work with files, create documents, operate browsers, arrange a persistent canvas, and run tasks locally or on your own Agent service.

Use the desktop app for a visual workspace, or install the Agent and CLI from npm to work in a terminal. API-key models can run without the desktop app. These entry points share the same Runtime, tools, plugins, skills and permission system.

## What you can do

| Capability | Use it for |
| --- | --- |
| Conversations and files | Stream responses, attach files and images, inspect tool activity, resume sessions, and continue work across long conversations. |
| Creation canvas | Combine Markdown, HTML, Office documents, PDFs, images, audio and video. Update content while retaining layout, pin a version, and discuss a selected region. |
| Team and subagents | Delegate work to named agents and assemble reusable tasks with dependencies, using the existing subagent execution and permission system. |
| Browsers and tools | Work with integrated browser tabs or authorized Chrome/Edge connections; extend capabilities with MCP plugins and skills. |
| Voice and personal assistant | Dictate into the draft, hold the main action button to call, or use a persistent assistant that delegates tasks. Voice services and optional local speech models are configured separately. |
| Local and remote work | Use the local CLI, deploy a worker service, connect an SSH workspace, or add an optional Linux desktop to a worker. |

## Download and install

| Entry point | Get it | Requirements |
| --- | --- | --- |
| Windows desktop | [Microsoft Store](https://apps.microsoft.com/detail/9N7XNDD5WRGS) | Follow the requirements of the package currently listed in the Store. |
| Agent + CLI | [npm package](https://www.npmjs.com/package/cardbush) | Node.js 24 and npm 10 or later; Windows and Linux. API-key models do not require Electron. |
| Desktop installers | [GitHub Releases](https://github.com/pycode4micro/cardbush/releases) | Choose assets actually attached to a release, for the matching OS and architecture. |
| Current source | [Development guide](CONTRIBUTING.md) | Build on the target operating system. |

These channels have separate release schedules. As of October 28, 2026, npm provides **1.0.13**, while GitHub's public desktop assets are still the **1.0.0-beta.3** prerelease. A release note in this repository does not mean a corresponding installer has been published. The Store listing is the authority for its available version.

Current desktop source targets **Windows 10 1809+ / Windows 11 x64** and **Linux x64**. The Store package can have a different minimum version until a compatible update is released. There are no published macOS, ARM64 or 32-bit desktop packages. See [installation and platform support](docs/INSTALLATION.md).

### Start in a terminal

```sh
npm install -g cardbush@latest
cd /path/to/your/workspace
cardbush
```

Local mode needs no connection token. If no model is configured, the CLI shows the configuration file and an example; edit it, save, and press Enter. The local CLI shares supported model, plugin and network settings with the app. ChatGPT account models reuse the app's authorization bridge and require the app to remain running.

```sh
cardbush --resume           # Choose a saved session
cardbush --resume SESSION   # Continue a specific session
cardbush --help
```

During a task, **Enter** queues the next message; **Ctrl+Enter** sends guidance immediately. Use `/steer TEXT` when the terminal cannot distinguish Ctrl+Enter. `/artifact` opens generated files, `/tools` shows execution details, and `/session` switches sessions. See the [CLI guide](docs/CLI.md).

### Start in the desktop app

1. Install and launch CardBush.
2. Open **Settings → Models** and add an API-key model or authorize a supported local account. Choose the API protocol that matches your provider.
3. Start a conversation, choose a working folder when needed, and describe the task. Review requested permissions before allowing an operation.
4. Open **Creation** to arrange files on a canvas, **Team** to manage reusable agents and workflows, or the sidebar assistant for a persistent conversation.

The microphone remains beside the main action button: click it to start dictation and click again to insert the transcript into your draft. It does not automatically send the text. Hold the main action button to call; use its stop control to hang up. See [voice setup](docs/REALTIME_VOICE.en.md).

### Run your own Agent

The npm installation includes both `cardbush` and `cardbush-agent`:

```sh
cardbush serve --background
cardbush serve --status
cardbush serve --stop
```

The default service directory is `~/.cardbush/service`. For an explicit directory or a service manager, use `cardbush serve --data-dir /absolute/path/agent-data`. The service owns its own models, credentials and sessions. See [Agent deployment](docs/AGENT_SERVICES.en.md) and [Docker deployment](deploy/agent/README.en.md).

**Current source preview:** remote services are registered as subagent workers through Team or `cardbush worker`, rather than opened as standalone Agents chats. Both ends must be rebuilt from the updated source. This migration and the experimental [subagent-remote-proton protocol](docs/SUBAGENT_REMOTE_PROTOCOL.md) are not included in the already published npm 1.0.13. Local CLI chat remains available, including on a server.

## Documentation

The [documentation index](docs/README.md) pairs current English and Chinese guides. Historical investigations and benchmark reports remain dated records.

| Topic | Guide |
| --- | --- |
| Installation, updates and troubleshooting | [Installation](docs/INSTALLATION.md) · [CLI](docs/CLI.md) · [npm distribution](docs/NPM_AGENT.en.md) |
| Models and accounts | [Model connections](docs/MODEL_CONNECTIONS.en.md) · [ChatGPT / SIWC](docs/SIWC_INTEGRATION.md) |
| Creation and documents | [Canvas](docs/creation-canvas.en.md) · [Persistent desk](docs/CREATION_DESK.en.md) · [Document plugins](docs/DOCUMENT_PLUGINS.en.md) |
| Team and assistant | [Team workflows](docs/TEAM_NATIVE_WORKFLOWS.en.md) · [Personal assistant](docs/PERSONAL_ASSISTANT.en.md) |
| Browsers, voice and automation | [Browser / Computer Use](docs/CORE_BROWSER_COMPUTER_USE.en.md) · [Voice](docs/REALTIME_VOICE.en.md) · [Automations](docs/AUTOMATIONS.en.md) |
| Remote operation | [Agent services](docs/AGENT_SERVICES.en.md) · [SSH workspaces](docs/SSH_WORKSPACES.en.md) |
| Development and releases | [Contributing](CONTRIBUTING.md) · [Architecture](docs/ARCHITECTURE.en.md) · [Release channels](docs/CROSS_PLATFORM_RELEASE.md) |

Security reporting, data handling and execution boundaries are documented separately in [SECURITY.md](SECURITY.md). For ordinary bugs and feature requests, use [GitHub Issues](https://github.com/pycode4micro/cardbush/issues).

## License

Original CardBush code is licensed under [Apache License 2.0](LICENSE). [NOTICE](NOTICE) and the [bundled licensing history](docs/BUNDLED_SKILL_LICENSES.md) describe third-party notices and boundaries. Dependencies and external plugins retain their own licenses.

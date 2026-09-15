# CardBush

**English** · [简体中文](README.zh-CN.md)

A desktop AI workspace for conversations, files, coding and MCP plugins. CardBush runs its Agent Runtime inside the application: no separate local server or Python installation is needed for core chat and terminal tools.

## Download

Current release: **1.0.0-beta.1**. Choose the package for your operating system.

| System | Download | Suitable computers |
| --- | --- | --- |
| Windows 10 / 11 | [Windows x64 installer (.exe)](https://github.com/pycode4micro/cardbush/releases/download/v1.0.0-beta.1/CardBush-1.0.0-beta.1-windows-x64-b7e0b7d.exe) | Intel / AMD 64-bit |
| Linux | [Linux x64 AppImage](https://github.com/pycode4micro/cardbush/releases/download/v1.0.0-beta.1/CardBush-1.0.0-beta.1-linux-x86_64.AppImage) | x86-64 desktop Linux; Ubuntu 22.04 or newer recommended |

[All releases and SHA-256 checksums](https://github.com/pycode4micro/cardbush/releases) · [Build and validation workflow](https://github.com/pycode4micro/cardbush/actions/workflows/desktop.yml)

The Windows installer was updated on September 15, 2026 from commit [`b7e0b7d`](https://github.com/pycode4micro/cardbush/commit/b7e0b7ded0542a0f9e7558aac93ca25762159a42), with consistent action colors, restored plugin navigation state and Windows icon fixes. Use `SHA256SUMS-win32-x64-b7e0b7d.txt` to verify this build. The Linux download remains the original beta build.

Windows 10 and 11 use the same installer; there is no separate Intel/AMD or GPU edition. ARM64, 32-bit Windows, Windows 7/8 and macOS packages are not part of this release. These beta packages are unsigned.

### Install and start

**Windows:** open the installer, choose an installation directory and launch CardBush. Uninstalling the application retains your local conversations and settings.

**Linux:** download the AppImage, allow it to execute, then run it:

```sh
chmod +x CardBush-1.0.0-beta.1-linux-x86_64.AppImage
./CardBush-1.0.0-beta.1-linux-x86_64.AppImage
```

AppImage needs FUSE 2 (on Ubuntu 22.04: `sudo apt install libfuse2`). If FUSE is unavailable, run with `APPIMAGE_EXTRACT_AND_RUN=1`. Chromium also requires a working sandbox; do not disable it as an installation workaround.

On first launch, open **Settings → Models** and configure a supported provider, model and API key. Model usage is billed by your provider. Plugins may require their own dependencies or credentials; follow each plugin's installation instructions.

## What is included?

- Streaming conversations, projects, file attachments and previews.
- File search and editing, terminal commands, tool permissions and execution history.
- Task queues, guidance, subagents, persistent sessions and automations while the application is running.
- MCP plugins, skills and an integrated browser.
- Personalization, keyboard shortcuts and persistent usage statistics.

Team workflows are a separate installable plugin, not part of the desktop bundle. See [Team plugin architecture](docs/TEAM_PLUGIN_EXTRACTION.md).

### Platform support

| Capability | Windows x64 | Linux x64 |
| --- | --- | --- |
| Chat, files, previews, MCP and integrated browser | Yes | Yes |
| Terminal commands | PowerShell / cmd | POSIX Shell |
| Embedded terminal selection | PowerShell; installed Git Bash / WSL | Native Shell; installed PowerShell |
| Bundled search | Native ripgrep | Native ripgrep |
| Windows computer-use plugin | Yes | Unavailable |
| Chrome native connector | Yes | Unavailable; integrated browser remains available |
| Native process CPU / memory enforcement | Windows Job Objects | Not yet implemented |
| Managed process admission and owned-process cleanup | Yes | Yes |

Linux does not claim the same resource isolation as Windows. External plugins remain separate programs with their own platform requirements. The terminal setting does not rewrite Agent commands into another Shell language.

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
npm run package:win     # Windows: NSIS installer
npm run package:linux   # Linux: AppImage
npm run smoke:packaged
```

On headless Linux, run desktop tests with `xvfb-run -a npm run test:release`. Outputs are in `release/`. `npm run test:release` requires a preceding build; it runs package tests, adversarial cases, platform contracts and Electron UI checks without repeatedly rebuilding each package. `npm run test:all` also runs the wider feature-specific checks. Provider tests use local mock HTTP servers; no live API key is needed.

Electron downloads use the official source by default. An optional `ELECTRON_MIRROR` can be configured for your network. Repair an incomplete download with `npm run fix:electron`.

## Architecture and maintenance

| Directory | Responsibility |
| --- | --- |
| `packages/cardbush-platform` | Host capabilities, Shell resolution, executable discovery and native resource paths |
| `packages/bush-runtime` | Provider-independent Agent loop, tools, permissions and state |
| `packages/bush-protocol` | Typed commands, events and IPC contracts |
| `packages/bush-provider-openai` | OpenAI-compatible provider transport |
| `electron` | Desktop lifecycle, isolated Utility Runtime host and native adapters |
| `src` | React UI and typed Runtime client |
| `scripts` | Development, regression tests, packaging and smoke checks |

Platform selection is centralized in `@cardbush/platform`; its browser-safe contracts and Node adapters are separate exports. OS-specific clipboard, computer-use and native process code stays in explicit adapters. Adding a host does not require changing the Agent loop. This release supports the application's terminal; it does not introduce a standalone CLI Agent.

See [cross-platform maintenance and release guide](docs/CROSS_PLATFORM_RELEASE.md), [app host](docs/host/CARDBUSH_APP_HOST.md) and [bundled apps MCP](docs/host/CARDBUSH_APPS_MCP.md).

## Data and security

The application stores conversations, usage records and settings locally under Electron's user-data directory. Clearing transient caches does not reset recorded usage. The renderer uses context isolation and no Node.js integration. Model providers and external plugins receive the data needed for their requested operations.

Do not attach credentials, raw conversation stores or unredacted logs to public issues.

## License

Original CardBush code is licensed under [Apache License 2.0](LICENSE). See [NOTICE](NOTICE). Bundled dependencies, skills and external plugins retain their respective licenses.

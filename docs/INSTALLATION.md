# Installation and updates

[English](INSTALLATION.md) · [简体中文](INSTALLATION.zh-CN.md)

## Choose an entry point

| Entry point | What is installed | Where it runs |
| --- | --- | --- |
| Microsoft Store MSIX | Desktop app and bundled runtime | Windows; use the Store listing's published requirements. |
| GitHub desktop assets | The installer or AppImage attached to that release | Its stated operating system and architecture. |
| `npm install -g cardbush` | Agent service, terminal CLI and required runtime resources | Node.js 24 on Windows or Linux, without Electron. |
| Source checkout | Development tools and locally built outputs | The target OS; see [Contributing](../CONTRIBUTING.md). |

Download from [Microsoft Store](https://apps.microsoft.com/detail/9N7XNDD5WRGS), [npm](https://www.npmjs.com/package/cardbush) or [GitHub Releases](https://github.com/pycode4micro/cardbush/releases). These channels are independent. As of October 28, 2026, npm is at 1.0.13 and the public GitHub desktop assets are the older 1.0.0-beta.3 prerelease. Do not infer availability from a source version, release note or successful Actions build.

Current desktop source targets Windows 10 1809+ / Windows 11 x64 and Linux x64; CI uses Ubuntu 22.04 for Linux. No macOS, ARM64 or 32-bit desktop packages are published. Windows 10 uses an ordinary window background; supported Windows 11 builds can use Mica. See [Windows compatibility](WINDOWS_COMPATIBILITY.md).

## Windows desktop

Install the Store package and start CardBush from Start. Windows manages MSIX updates. Back up wanted data before uninstalling an MSIX package, because package-owned data is removed during normal uninstallation.

If using a GitHub EXE, verify its release, architecture and attached SHA-256 checksum. A development installer or CI artifact is not the same as a signed public release. Terminal tools require an available supported shell; PowerShell 7 and Git for Windows are needed for the corresponding operations. Plugin-specific accounts and optional dependencies remain separate.

## Linux desktop

Download a matching x86-64 AppImage, rename it if needed, then run:

```sh
chmod +x CardBush.AppImage
./CardBush.AppImage
```

AppImage requires FUSE 2; Ubuntu 22.04 provides `libfuse2`. If FUSE is unavailable, use:

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./CardBush.AppImage
```

The Chromium sandbox must remain available. Do not use `--no-sandbox` as a general installation workaround. The Windows external-browser connector and Windows Computer Use plugin are not Linux desktop features; integrated tabs remain supported. The optional remote Linux desktop uses a separate integration.

## npm Agent and CLI

```sh
node --version
npm --version
npm install -g cardbush@latest
cardbush --version
cardbush --help
```

Use Node.js 24 and npm 10 or later. The package registers `cardbush` and `cardbush-agent`; no separate private workspace packages or Electron installation are needed. Third-party dependencies are installed for the target platform.

Enter a working directory and run `cardbush`. New sessions use that directory. On Windows, use a Windows path, for example `Set-Location C:\Work\project`. With no model configured, follow the CLI's file-editing prompt. `/settings` shows configuration locations; `/model` selects a model. Local API-key models work independently; supported account models use the app's local authorization bridge. See [CLI](CLI.md), [models](MODEL_CONNECTIONS.en.md) and [SIWC](SIWC_INTEGRATION.md).

### If the command is missing or stale

On Windows, check `Get-Command cardbush -All` and `where.exe cardbush`; on Linux, check `command -v cardbush` and `type -a cardbush`. Compare these with `npm prefix -g` and `npm ls -g cardbush --depth=0`. Put npm's global command directory on your user PATH, then open a new terminal. On Windows this is usually the global prefix itself; on Linux it is usually its `bin` subdirectory. Use the path actually returned on your machine.

An `npm link` installation points into a source checkout. It uses that checkout's built output and does not rebuild automatically when Git changes. Rebuild with `npm run build:agent`, or replace the link with a registry installation. Compare the resolved command and installation source, not only `--version`.

## Update or uninstall

```sh
npm install -g cardbush@latest
cardbush --version
```

New CLI processes use the new code. Wait for accepted service tasks to finish, stop the corresponding service, update the package, then restart that service with its original data directory and options. An npm update does not update the Store app, a Docker image or another machine's installation.

```sh
npm uninstall -g cardbush
```

`npm uninstall cardbush` without `-g` only affects the current npm project and does not remove the global command. Uninstalling npm program files does not automatically remove independent Agent or CLI data directories. Back up and manage those directories explicitly; do not remove another service's active directory.

## First configuration and troubleshooting

In the app, open Settings → Models. For API-key models, select the provider and matching Responses, Chat Completions or Anthropic Messages protocol. For supported accounts, complete local authorization. Each conversation retains its model selection; the configured default applies to new conversations.

For a model error, record the protocol, model and non-secret error details. For CLI issues, use `/logs` and `--version`. For Browser Use, use `/browser status` and the extension's Connect action; see [browser setup](CORE_BROWSER_COMPUTER_USE.en.md). For runtime failures, inspect the actual host's logs and resources rather than repeatedly reinstalling unrelated clients.

See [security and data handling](../SECURITY.md), [npm packaging](NPM_AGENT.en.md), [Agent services](AGENT_SERVICES.en.md) and [Docker deployment](../deploy/agent/README.en.md).

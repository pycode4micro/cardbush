# CardBush Agent + CLI npm package

[English](NPM_AGENT.en.md) · [简体中文](NPM_AGENT.md)

The official [cardbush npm package](https://www.npmjs.com/package/cardbush) includes an independent Agent service and terminal client. The same release serves Windows and Linux and requires Node.js 24 and npm 10 or later. API-key models do not require the desktop app.

This guide follows current source. Published **1.0.13** does not include the new `cardbush worker` registration or removal of remote chat selection. Rebuild both ends from current source to use the worker features below. See the [1.0.13 release scope](https://github.com/pycode4micro/cardbush/blob/main/docs/releases/1.0.13.md).

## Install and start

```sh
npm install -g cardbush@latest
cardbush --version
cardbush --help
cd /path/to/workspace
cardbush
```

Local mode needs no access token. With no configured model, follow the CLI's configuration path and example, save the file, and press Enter. `/settings` shows configuration locations; `/model` selects a model and reasoning effort. ChatGPT account models reuse the local app's authorization bridge, so keep the app signed in and running. API-key models can execute independently.

`cardbush --resume` opens the session picker; `cardbush --resume ID` resumes a specific session; `/session` switches sessions in the terminal. During execution, Enter queues a message and Ctrl+Enter or `/steer TEXT` guides the current task immediately. `/artifact` lists and opens files; `/tools` shows execution details. See the [CLI guide](https://github.com/pycode4micro/cardbush/blob/main/docs/CLI.md).

## Service and remote connections

One installation registers both `cardbush` and `cardbush-agent`:

```sh
cardbush serve --background
cardbush serve --status
cardbush serve --stop
cardbush serve --data-dir /absolute/path/agent-data --name Agent-A
# Equivalent foreground service entry
cardbush-agent --data-dir /absolute/path/agent-data --name Agent-A
```

The default background-service directory is `~/.cardbush/service`. Use Windows absolute paths on Windows. Program files and data are separate; a normal remote client's exit does not stop the service. Give independent instances separate data directories.

```sh
cardbush worker add --name Worker --url https://agent.example.com --token-file /private/access-token
cardbush worker list
```

Remote chat selection is retired; old connection settings cannot redirect the local CLI. Register the endpoint as a worker and ask the local Agent to save its role. Remote model/plugin configuration and permissions remain independent. CLI sessions use `~/.cardbush/cli-agent`; the HTTP service uses `~/.cardbush/service`. These are separate stores. Use HTTPS or authenticated SSH remotely. See the [worker protocol](https://github.com/pycode4micro/cardbush/blob/main/docs/SUBAGENT_REMOTE_PROTOCOL.md).

## Update and uninstall

```sh
npm install -g cardbush@latest
cardbush --version
npm uninstall -g cardbush
```

Open a new CLI after updating. For a service, wait for tasks to become idle and restart with its original directory and options. An npm update does not update the desktop app, other machines or Docker images. Removing a global command requires `-g` and does not automatically erase service data. An `npm link` installation also needs rebuilding after source changes; see [installation troubleshooting](https://github.com/pycode4micro/cardbush/blob/main/docs/INSTALLATION.md).

## Maintainer packaging and publication

The root `package.json` has `private: true`; do not publish the repository root. This flag does not mean the GitHub repository is private. `npm run package:npm` builds an independent release directory and tarball without publishing. The package includes internal workspaces and runtime assets; npm installs third-party dependencies for the target platform. It does not download Electron or include desktop installers. Windows native process-protection components must be complete.

```sh
npm run package:npm
npm run verify:npm-package -- --tarball /absolute/path/cardbush-1.0.13.tgz
npm publish /absolute/path/cardbush-1.0.13.tgz --access public --tag latest
```

Verification installs outside the checkout, checks commands, native assets, service authentication and bundled MCP discovery, and exercises independent CLI and service conversations using a local mock model. It does not replace the global installation, read real user configuration or make paid calls. Results are saved in `verification-report.json`.

Publish the exact tested tarball. npm can require terminal sign-in and separate two-factor verification for publication; keep credentials and codes out of the repository. If npm reports processing, wait for scanning rather than republishing. Verify `latest`, version metadata and the integrity of an anonymous download before declaring the package installable.

Optional Browser Use, Computer Use and Office conversion still depend on the target host and dependencies. See [security and data boundaries](https://github.com/pycode4micro/cardbush/blob/main/SECURITY.md).

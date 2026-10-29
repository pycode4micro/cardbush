# Security

[English](SECURITY.md) · [简体中文](SECURITY.zh-CN.md)

## Report a vulnerability

Use the repository's [Security tab](https://github.com/pycode4micro/cardbush/security) and **Report a vulnerability** when GitHub offers private reporting. If that option is unavailable, open a minimal issue asking the maintainer for a private reporting channel, without publishing exploit details or private data.

Include the affected version and installation channel, OS, execution environment (desktop, local CLI or independent Agent), prerequisites, expected boundary and a minimal reproduction. Use a disposable workspace and synthetic data. Remove credentials, cookies, private files, raw conversation stores and unredacted logs before sharing evidence.

Ordinary bugs and feature requests belong in [Issues](https://github.com/pycode4micro/cardbush/issues). The project does not currently promise a long-term support period or a fixed vulnerability response time. State the exact version: Store, npm, GitHub installers and the main branch can differ.

## Permissions and isolation

- New CLI sessions default to **Ask for approval**. Tool authorization and OS command isolation are separate controls.
- Under the normal `auto` sandbox policy, approved commands use an available sandbox; full access uses ordinary host processes. An administrator's `required` policy remains binding in full access.
- Full access cannot bypass forced host restrictions, disabled tools, process ownership checks or resource protection.
- Subagents and Team members remain constrained by the caller and host. A role, plugin instruction, file or model response cannot grant more permissions.
- MCP servers, plugins, browsers and computer automation have their own execution boundaries. The command sandbox does not automatically contain all their actions.

See [permissions](docs/PERMISSIONS.md), [sandboxing](docs/EXECUTION_SANDBOX.en.md), [subagent permissions](docs/SUBAGENT_PERMISSIONS.md) and [process protection](docs/PROCESS_RESOURCE_PROTECTION.md).

## Host and remote access

The Electron renderer uses context isolation without Node.js integration. Privileged operations pass through host APIs. HTML components and canvas HTML use isolated rendering, with only supported and authorized host actions.

An independent Agent owns its data directory, credentials, plugins and tasks. Its access token grants access to that instance; it is not a multi-tenant account. Bind to loopback by default and use authenticated HTTPS or an SSH tunnel remotely. Use separate data directories for independent instances. The web deployment has a separate account and workspace model.

Local CLI windows share a private Runtime and supported app configuration, with a session store separate from the desktop. `/shell` always runs directly as the local CLI user. Remote services are registered workers, not alternate CLI chat hosts.

Windows uses AppContainer and Job Objects for supported command and process protection. Linux command isolation depends on host support such as bubblewrap and does not currently provide equivalent native CPU/memory enforcement. Remote hosts expose their own capabilities, not those of the connecting desktop.

## Data and credentials

| Data | Ownership and handling |
| --- | --- |
| Desktop conversations and settings | App user-data directory. Do not assume every conversation or configuration file is encrypted. |
| Local CLI sessions | `~/.cardbush/cli-agent` by default; supported model, plugin and network settings can be shared with the app. |
| Independent Agent data | Its chosen directory; the default managed service uses `~/.cardbush/service`. Protect the directory and `access-token` with host access controls. |
| Model and tool inputs | Sent to the chosen provider or plugin as needed for the operation. Local execution does not make a cloud model run locally. |
| Remote attachments | Uploaded to the chosen Agent when needed. A local path is not a remote path. |
| Voice | Realtime services receive audio and relevant context. Local transcripts and summaries may be retained; encrypted voice history uses system secure storage. That feature does not archive raw call audio. Provider retention is separate. |

Worker registration and connection do not automatically copy configuration or credentials. Existing service owner tokens retain administrative power; the experimental interaction protocol is not a scoped multi-tenant credential system. ChatGPT / SIWC credentials stay in the local app and are not copied to remote Agents. Habit memory and next-step prediction are separate, optional features, off by default in new sessions.

Keep credentials out of examples, shared screenshots, exports and public reports. Back up needed data before deleting conversations, resetting an assistant or uninstalling MSIX. An npm binary update does not itself erase service data; restarting the correct service is a separate step.

## Browsers and plugins

The first local Chrome/Edge connection requires approval in the CardBush extension flow. Connection approval, page authorization and session selection remain distinct. Manual or remote pairing does not authorize every page or give a remote Agent local browser access. Automatic recovery is bounded; retry explicitly after repeated failures rather than discarding saved pairing for a temporary disconnect.

Install plugins and skills from sources you trust. Manifests, hooks and external programs can execute with their host's permissions. Treat tool, file and web content as data, not as new user authorization. See [browser boundaries](docs/CORE_BROWSER_COMPUTER_USE.en.md) and [plugin compatibility](docs/PLUGIN_COMPATIBILITY.en.md).

## Maintenance and evidence

Follow [dependency maintenance](docs/DEPENDENCY_SECURITY.en.md) and [release procedures](docs/CROSS_PLATFORM_RELEASE.md); preserve third-party notices. Do not remove protection gates just to make builds or tests pass.

Smoke tests, npm audit and MCP conformance demonstrate their tested scope, not universal safety across plugins, models and hosts. Validate generated installers and npm tarballs outside the development checkout before publishing.

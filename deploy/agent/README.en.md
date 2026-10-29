# Independent worker deployment and optional desktop

[English](README.en.md) · [简体中文](README.md)

The default is a Node service, without an automatically started desktop or browser. Plugins may supply those capabilities through their own MCP connections; availability must be verified. This guide describes current source. Published npm versions may predate the remote-worker migration, which requires updating both ends.

## Service and local CLI

The [npm package](../../docs/NPM_AGENT.en.md) delivers `cardbush` and `cardbush-agent` together, without the desktop App. Source/directory deployments can register commands after building with `npm link --ignore-scripts`. Standard, desktop and Web Docker images also contain both commands.

```sh
npm install -g cardbush
cardbush serve --background
cardbush serve --status
cardbush serve --stop
cardbush serve --data-dir /srv/cardbush/worker-a --name Worker-A

cd /path/to/project
cardbush
cardbush --full-access
cardbush --resume
cardbush --resume SESSION_ID
```

The service defaults to `~/.cardbush/service`, `127.0.0.1:4780`. Status reports token/config/log paths, not their secrets. Background mode runs Node without a PowerShell window and does not install a system/startup service; system managers should supervise foreground `cardbush serve`. Keep existing instance data with explicit `--data-dir`.

Local CLI needs no HTTP service or user-supplied token. Multiple windows share a private local Runtime, with separate sessions under `~/.cardbush/cli-agent`. App model/plugin/MCP/network/sandbox settings are shared for that user, while desktop and CLI conversation databases are separate. A CLI on a server is local to that server; it does not attach to the HTTP instance's database. See the [CLI guide](../../docs/CLI.md) for configuration, keyboard input, queue/insert, history, `/session`, `/tools`, `/artifact`, file references, shell, habit settings, logs and exit codes. API-key models need no App; ChatGPT account models still need the local desktop authorization bridge, not copied OAuth registrations.

Register remote execution from App Team employees, or:

```sh
cardbush worker add --name Worker-A --url https://agent.example.com --token-file /private/access-token
cardbush worker verify CONNECTION_ID
cardbush worker list
```

Ask the local Agent to bind the verified connection/instance to a subagent role. Chat `--url/--token-file` is retired; registration does not copy parent history, model secrets, plugin configuration or personal files. The worker retains its model/workspace/policy ceiling. Tokens are currently administrative credentials for a trusted parent host, not scoped credentials for arbitrary third parties. See [service architecture](../../docs/AGENT_SERVICES.en.md) and [interaction protocol](../../docs/SUBAGENT_REMOTE_PROTOCOL.md).

Windows tools require PowerShell 7 (`pwsh`), without Windows PowerShell 5 fallback, and support AppContainer/native resource protection. Linux bubblewrap requires installation and user namespaces; it does not provide extra seccomp filtering or Windows Job-equivalent kernel resource limits. Failed required isolation never falls back to unrestricted host execution. The [deployment reference](../../assets/skills/cardbush-docs/references/agent-deployment.md) has detailed platform/configuration steps; current public entry points are those above. Deployers manage accounts, service managers and plugin dependencies; the core does not provision them automatically.

Source directory packaging: `npm run package:agent -- --out <new-directory>`, including service, CLI, assets, deployment Skill and DEPLOY.txt. Use a published version or install the target platform's dependencies; building a directory is not installing it.

## Optional worker desktop

Only add graphics when the independent worker needs visible UI:

```sh
docker compose -f deploy/agent/compose.yaml -f deploy/agent/compose.desktop.yaml up --build -d
```

This selects the desktop image and explicit `--desktop`, with Xvfb, Openbox, visible Chromium, Computer Use and Browser Use. Without it, those built-in backends do not start; independent configured MCPs are unaffected. Desktop startup failure fails startup rather than targeting a client's desktop or disabling the browser sandbox.

Docker needs user namespaces, Buildx and Compose v2. Chromium runs as a regular user with sandbox. The seccomp profile derives from [Playwright v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json), additionally permitting namespace-local chroot with `cap_drop:ALL`, without added capabilities. Do not substitute privileged, host IPC, Docker socket, host X socket or `--no-sandbox`. Fix the deployment environment if user namespaces are disabled. See [Chromium](https://chromium.googlesource.com/chromium/src/sandbox/+/refs/heads/main/linux/services/credentials.cc), [Docker](https://docs.docker.com/engine/containers/run/) and [Playwright](https://playwright.dev/python/docs/docker).

Both compose configurations publish only host loopback 4780, accessed through HTTPS/SSH worker registration. First start creates `/data/access-token`; retrieve privately without committing/logging/screenshotting it. Existing Agent authentication protects desktop operations, with no public VNC/CDP/X11 port. Use separate Compose `--project-name` and volumes per worker/person; both images use UID 1100. Preserve volumes on upgrade; never `down -v`. `/data/desktop/browser` contains login data and needs secret-grade backup protection; client browser logins are not copied.

## Desktop contract and limits

- Capability snapshots and authenticated management APIs expose optional desktop support. App standalone Agents chat is removed; a capability flag does not imply a new user takeover UI. The default service has no desktop.
- On-demand JPEG preview is approximately one frame per 700ms, network/work dependent, not video streaming. Hidden preview stops capture. `CARDBUSH_DESKTOP_SIZE` defaults to 1600×900.
- Takeover is an exclusive server lease shared by Computer/Browser Use, expiring after 20 seconds without renewal and released on close. Dispatched input settles before takeover is confirmed; queued agent actions cannot cross it. Failure/disconnect is not successful ownership.
- Click/drag/scroll/shortcuts/Unicode operate on the same desktop. Original image coordinates exclude letterboxing; stale size/frame rejects input.
- `linux_computer_use` uses screenshot pixels; `linux_browser_use` uses the same visible browser for tabs/text/element indexes/screenshots/input/navigation. DOM covers visible top-level controls; iframe/canvas uses computer control.
- Model screenshots require the conversation's existing vision option; deployment cannot override a disabled setting. Human preview/DOM text remain possible.
- Observations bind session/turn; actions require fresh observations, and another session/human action invalidates them. Computer Use also verifies image change. Full terminal access is not constrained by the desktop takeover lock; do not treat it as a hostile-agent sandbox.
- Closing preview/client/turn does not close the browser. Container stop does. Volumes preserve profile, not all transient page state; unknown timed-out input is never automatically replayed.
- A desktop is shared by that worker's sessions. Separate people/accounts needing physical isolation require separate containers/volumes.

## Dependencies and verification

Explicit plugin synchronization updates selected package files/enablement, preserving target plugin parameters and independent MCP config; it does not harvest sender environment/settings, infer interpreters, install dependencies or rewrite commands. Plugin launch scripts still run as declared. Document dependencies/config/checks in the plugin's Skill or references, then let the receiving worker handle its actual host/account/purpose using [plugin management](../../assets/skills/cardbush-docs/references/plugin-management.md). Do not add environment-copy switches or automatic model setup jobs.

`npm run test:agent-desktop` on Windows checks contracts, leases, coordinates and default-off behavior, not actual Linux deployment. On a suitable isolated Linux Docker host:

```sh
docker compose -f deploy/agent/compose.yaml -f deploy/agent/compose.desktop.yaml build
docker compose -f deploy/agent/compose.yaml -f deploy/agent/compose.desktop.yaml run --rm --no-deps --entrypoint /bin/bash agent -lc 'Xvfb :99 -screen 0 1600x900x24 -nolisten tcp & sleep 1; openbox & /opt/desktop-venv/bin/python3 scripts/agent-desktop/smoke.py'
docker compose -f deploy/agent/compose.yaml -f deploy/agent/compose.desktop.yaml run --rm --no-deps --entrypoint /bin/bash agent -lc 'Xvfb :99 -screen 0 1600x900x24 -nolisten tcp & sleep 1; openbox & node scripts/test-agent-desktop-live.mjs'
```

Fixtures use disposable profiles/local pages, no model or real accounts. Validate actual preview/takeover/release, browser retention on preview close and container restart, and absence of graphics in the default image. Build/unit success does not certify those cases. The source's 2026-10-03 Ubuntu/Windows-client validation and old `--desktop-live` procedure remain historical only: `run-agents-ui-test.mjs` now checks worker registration, not that removed standalone UI. It was functional evidence, not a multi-task stress test or certification of third-party website login.

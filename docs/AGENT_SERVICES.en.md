# Independent Agent service and remote workers

[English](AGENT_SERVICES.en.md) · [简体中文](AGENT_SERVICES.md)

This guide describes current source; published binaries may predate the worker migration. Rebuild both ends. A service owns its Runtime, model, workspace, queue and history. App/CLI use it as a registered subagent, not a standalone Agents chat, and no longer copy desktop configuration/API keys on connection. See [subagent-remote-proton](SUBAGENT_REMOTE_PROTOCOL.md).

## Install and run

The [npm package](NPM_AGENT.en.md) includes service and CLI without Electron. Use Node.js 24 and npm 10+, matching `.nvmrc`/CI. A server-installed `cardbush` chats locally on that server with a separate session store; it does not attach to the HTTP service's database.

```sh
npm install -g cardbush
cardbush serve --background
cardbush serve --status
cardbush serve --stop
cardbush serve --data-dir /srv/cardbush/worker-a --name Worker-A --host 127.0.0.1 --port 4780
# cardbush-agent is the service entry-point alias
```

Source deployment:

```sh
npm ci --ignore-scripts
npm run build:agent
node dist-electron/agentServiceCli.mjs --data-dir /srv/cardbush/worker-a --name Worker-A
```

Ignoring install scripts avoids downloading Electron; build-time types do not make the runtime an Electron process. Defaults: service `~/.cardbush/service`, local CLI sessions `~/.cardbush/cli-agent`. Use Windows absolute paths on Windows.

Start each instance with a separate empty directory, never desktop data. Locks reject another process and existing Runtime data without service identity. `agent.json` preserves identity. Back up a stopped directory or consistent snapshot, including token, runtime-state, config, plugins/marketplaces, skills, bundled assets and AGENTS.md, with equivalent access protection. One directory supports one process on one host, not NFS replicas or distributed leases.

## Network and identity

Default bind is `127.0.0.1:4780`. A random token is stored in owner-only `access-token` on POSIX, or supplied by `CARDBUSH_AGENT_TOKEN` (at least 32 characters). Logs show its path only. This is an administrative instance credential, not a scoped multi-tenant delegation token.

Use HTTPS or authenticated SSH remotely; plaintext HTTP is loopback-only. SSH worker connections reach remote loopback HTTP through SSH channels without a local listening forward. SSH projects instead keep the loop local and execute selected file/command operations remotely; these are different architectures.

Reverse proxies must preserve Authorization, Accept, Last-Event-ID, X-CardBush-Agent-ID, Origin and `/api/agent/v1/` paths, disable buffering/caching, and allow long reads (300 seconds recommended; stream heartbeat approximately every 15 seconds). Do not blindly retry mutating POSTs. Origin headers, including null, are rejected rather than granted CORS. `/health` also requires authentication. The [Web deployment](../deploy/web/README.en.md) has its own account/private-gateway boundary.

## Register and delegate

App: **Team → employees → remote workers**, add/verify a connection and save a role. CLI:

```sh
cardbush worker add --name Worker-A --url https://agent.example.com --token-file /private/access-token
cardbush worker list
cardbush worker verify CONNECTION_ID
cardbush worker remove CONNECTION_ID
```

Ask the local Agent to bind a role to the returned connection and verified instance. Existing subagent/tasks/Team tools use it without seeing the token. App and CLI currently have separate credential/connection stores, so the role must reference a connection on the executing parent host. Old endpoints remain candidates, and an instance change at the same URL needs explicit new registration.

Role name, instructions and revision accompany work. The worker uses its default model/project, or creates a workspace without a default project. Parent history, local paths, browser grants and credentials are not copied. Continuations keep original role/service identity. Remote roles reject local tools/settings/hooks/guards that cannot be enforced on an independent host.

`subagent({agent_id,prompt})` starts work; `task_id` continues the child, `delivery:"queue"` schedules a later run and `delivery:"insert"` guides the exact active run. `tasks` inspects, waits, reads conversations and stops work. Child questions use words; parent answers resume the same run. Permissions are structured. External implementations need not use these model-facing tool names.

## Policy and configuration

The worker defaults to `CARDBUSH_REMOTE_PERMISSION_MODE=task_free`, intersected with the parent's request. An administrator may choose user_free/all_free, but required sandbox and process protections remain. `CARDBUSH_REMOTE_PARENT_APPROVAL=0` requires human authority; 1 explicitly delegates one-use decisions to the parent within the protocol. Prose, a parent's full-access mode or a claimed human identity grants nothing. Without an authorized approval channel, wait/deny/cancel.

Service startup probes installed sandbox support without downloading it. `--sandbox required` imposes a ceiling; `--sandbox off` is an explicit administrator policy. Linux bubblewrap, Windows AppContainer, path permissions, plugins and page grants are distinct; see [execution sandbox](EXECUTION_SANDBOX.en.md).

Configure models/MCP/plugins/instructions/network on the worker. Use the cardbush-docs [deployment](../assets/skills/cardbush-docs/references/agent-deploy.md) and [plugin-management](../assets/skills/cardbush-docs/references/plugin-management.md) references for an explicit target. Administrative API availability does not grant model access. Legacy v2 `configuration.sync` remains for explicit management compatibility; connection/delegation does not invoke it automatically. OAuth, browser login and development virtual environments do not migrate.

Marketplaces accept GitHub shorthand, HTTPS/SSH Git and local directories. `plugins.marketplace` supplies sources/catalog/preview/install, gated by `pluginMarketplace`; previews belong to the creating instance. Network settings come from the target's `config/network.json`, otherwise process HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY; direct mode explicitly bypasses proxies. Plugin `cardbush.runtime.platforms/requires/mcpServersByPlatform` uses actual target OS/account/dependencies, not an assumption that SSH means Linux.

## Lifecycle and recovery

Persist before acknowledging. One session runs sequentially; sessions can run independently. IDs bind content, and uncertain acknowledgements reuse the same ID. Queue, guidance and stop are separate. Locking the user queue neither retracts accepted tools nor resolves permission waits. Replacement dispatch into an active child is rejected; explicit queue schedules later work.

Closing a subscription/network connection does not stop work. SSE/NDJSON resume the same task/cursor; stopping needs an explicit request and confirmation. Recovery has a budget; exhausted observation becomes local `unavailable`, not a remote stopped state. Restart restores queued work and marks previously active jobs interrupted without replaying uncertain effects. Graceful shutdown stops active work and preserves the queue. Parent restart does not yet reattach interaction watchers automatically; inspect the original task.

Incomplete/conflicting tool calls reject the whole batch before execution. Runtime appends one repair request and ends the round if repair fails; checkpoints retain repair budgets without rewriting prefixes or repeating actions. Goals use the same Runtime and yield to queued user work. See [context and memory](CONTEXT_AND_MEMORY.md).

## HTTP management API and streams

Use Authorization: Bearer TOKEN. Call JSON is limited to 2 MiB.

| Route | Purpose |
| --- | --- |
| `GET /api/agent/v1/info` | Protocol `cardbush.agent.v1`, API version, identity and capabilities. |
| `POST /api/agent/v1/call` | `{operation,input}`; success `{result}`, non-2xx errors `{error:{code,message}}`. |
| `GET /api/agent/v1/events?sessionId=...&turnId=...` | SSE or NDJSON selected by Accept. |

X-CardBush-Agent-ID pins identity (409 on mismatch). `afterSequence` belongs to the session/turn and takes precedence over SSE Last-Event-ID. Frames are ready/event/end/error; SSE event IDs are sequence numbers and heartbeats are comments, NDJSON heartbeats are `{"type":"heartbeat"}`. This is the current CardBush HTTP binding, not MCP Streamable HTTP wire compatibility.

| Category | Operations |
| --- | --- |
| Worker | `delegation.submit`, `delegation.control`; see the versioned interaction contract. |
| Projects/history | `projects.*`, `sessions.*`, `chat.jobs/events/stop/queue`. |
| Compatibility management chat | `chat.send`; retained admin API, not an App/CLI remote-chat entry. |
| Resources | `conversation.catalog/extracts`, `files.upload/read/list/pasted-text`. |
| Configuration | `product.command`, revision-checked `instructions.get/save`. |
| Plugins/MCP | `plugins.*`, `mcp.list/configure/remove/reconnect`. |
| Runtime | Allowed queries/interactions through `runtime.command`; execution goes through the queue, not a second loop or host shutdown command. |

Attachments retain the 64 MiB/file and 512 KiB chunk bounds; repeated chunks must match. Resource reads are scoped to the workspace and reject escapes/external symlinks. Remote paths never go to a local file API. HTML preview uses an isolated origin for relative assets, with no Node, credentials or local files. Deliver artifacts by explicit transfer, not automatic download from model-written paths.

## Graphics, deployment and updates

Default Node service needs no desktop/browser/Docker, provides no desktop login dialog, and inherits no local plugin sessions. Explicitly add an [optional Docker Linux desktop](../deploy/agent/README.en.md):

```sh
docker compose -f deploy/agent/compose.yaml up --build -d
docker compose -f deploy/agent/compose.yaml -f deploy/agent/compose.desktop.yaml up --build -d
```

The desktop/browser profile/volume belong to that worker; independent people need independent containers/volumes. For long-running Linux deployments use a regular service account, systemd Restart=on-failure, sufficient shutdown timeout and UMask=0077. Legacy stdio records retain migration notices without executing their command; deploy HTTP and register again. `--transport http` is compatibility-only; stdio is rejected.

Updating service/CLI files does not update running processes or the desktop App. Preserve data and restart after work settles. Update bundled skills with release assets while retaining user skills. Tool schemas, loop logic and product instructions come from built code; JSON/config sync cannot replace upgrading. Inspect the target version and catalog to confirm the active build.

Tests: `test:agents`, `test:remote-workers`, `test:agents-ui`, `test:agent-chat`. They use isolated Node workers, simulated models, real local HTTP/CLI and UI, not production deployment. Independent worker adapters need separate interaction-contract validation; any future MCP binding also needs the conformance checks for its advertised revision.

# Web deployment: remote subagents only

[English](REMOTE_AGENTS.en.md) · [简体中文](REMOTE_AGENTS.md)

Management → Remote Agents registers, verifies, edits, disables and removes independently deployed workers. It creates no local process/container/agent, assembles no role automatically and copies no model/plugin configuration. Administrators must deploy and configure the service first.

## Deploy a worker

In a built repository with Node.js 24+:

```sh
node dist-electron/agentServiceCli.mjs --data-dir /srv/cardbush/agent-employee-a --name Video-worker --host 127.0.0.1 --port 4780
```

On Windows use an absolute Windows directory, e.g. `D:\CardBushAgents\employee-a`. Give each isolated person an independent instance/data directory or container/volume and only their allowed mounts; never use desktop data or other people's roots. `deploy/agent/compose.yaml` exposes host loopback for SSH. Direct access needs HTTPS reverse proxy, or trusted private-network HTTP under the Web deployment's own policy.

Configure the worker's default model, tools and instructions on that host. The App no longer provides standalone Agents chat/remote model editing, and the website copies no credentials or dependencies. Do not use `--disable-tools` (no delegation) or `--web-restricted` (internal tenant entry, not an external worker). First startup writes access-token, or use deployment `CARDBUSH_AGENT_TOKEN`.

## Register in the website

1. As administrator, open Management → Remote Agents → Register.
2. Supply name/capabilities. For SSH, supply host, port (22 default), user, full private key/optional passphrase or password, remote service port (4780 default) and Agent access token. SSH and service credentials are distinct.
3. Select one or more authorized people, searchable by name/account/company/department. Select/deselect current results affects only that filter; search retains selections, clear all revokes them. Enable and save atomically.
4. First detection displays the SSH fingerprint. Compare with the remote administrator, explicitly trust it, retry detection, then verify/save. Unknown fingerprints do not log in; changed pinned fingerprints fail. The service token, CardBush/delegation capability and persistent instance identity are also checked.
5. An authorized person can ask the assistant to delegate. `list_subagent_options` discovers allowed targets, `subagent` dispatches, `tasks action=wait` waits and original task_id follows up. [subagent-remote-proton](../../docs/SUBAGENT_REMOTE_PROTOCOL.md) adds observed progress, queue/insert, questions, structured responses and confirmed cancellation.

The SSH server must be reachable from the NAS and permit TCP forwarding to its loopback service port. Only channels are created: no shell/SFTP, local listening forward or remote process startup. Limit each SSH account to its worker port. Admin fingerprint commands include `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`; Windows usually keeps the public host key under `C:\ProgramData\ssh`. Compare the actual negotiated key, not an arbitrary different key.

HTTP(S) accepts a service URL, optionally ending `/api/agent/v1`; public Internet requires HTTPS, HTTP is private-network only. Direct/SSH host addresses reject NAS loopback, link-local and embedded credentials; the SSH target is fixed remote loopback. Blank credential fields on edit retain the saved value; a new key needs its passphrase. Connection type/host/user/ports/fingerprint are pinned; a new target needs a new registration. Disable/remove works offline.

## Automatic video slicing

The built-in `auto-video-slicing` Skill (`assets/skills/auto-video-slicing/SKILL.md`) only organizes/delegates. The website installs no Baiying/editing/Qianchuan tools; workers provide and describe them.

Supply four required values as strings: Baiying login phone, streamer name, original product style codes (semicolon-separated) or explicit product IDs, and target Qianchuan video-library account ID. Also specify count, selection/subtitle/transition requirements. Missing values require clarification; different phone/streamer/account groups delegate separately. Workers verify actual accounts/products, upload each completed clip, name it `yyyy-mm-dd_Ai_切片_原厂款号_主播名` with sequence suffixes when needed, and inspect unknown outcomes before retrying. Final delivery lists video IDs, upload success/failure and missing information per product. Planning-only requests stop at that requested endpoint.

## Authority and execution

- Only administrators edit registrations. Database-encrypted service/SSH secrets return only configured markers; normal users/models cannot read them. These service tokens remain administrative credentials, so only trusted gateway hosts should hold them.
- One worker may be authorized to multiple people, never everyone implicitly; old single grants are preserved on editing. Address aliases cannot duplicate the same instance.
- Tenant and parent session scope every ID/read/control, with transformed remote IDs. Worker files, plugins and login state remain its shared host resources; use separate instances for physical isolation.
- The gateway forwards requested parent mode rather than forcing all_free. The worker intersects it with `CARDBUSH_REMOTE_PERMISSION_MODE` (task_free default); sandbox/resource ceilings remain. Structured approvals require allowed remote authority, not prose. Existing tasks are not silently re-permissioned.
- Every delegate/read/follow-up checks account/grant/ownership. Revocation immediately rejects new actions and requests cancellation of active work on the next periodic grant check (10 seconds). Unreachable workers cannot guarantee immediate stop; confirm the original task before replacement work.
- Native async/SSE remains; maximum four concurrent remote tasks per account, sixteen gateway-wide, with explicit capacity errors.
- Reconnect retains validated SSH identity, original task and cursor; transport does not replay creation/upload. Exhausted observation is unavailable, not proof of termination.
- Only assignment text and explicit worker role data transfer, not parent transcript, files, keys or plugin config. Remote artifacts are not auto-copied into personal website files.
- Models cannot register/start local agents or bypass Web policy through fork/clean/plugin roles/registration/legacy local task IDs. Standalone App/CLI remote chat removal does not weaken the Web gateway's tenant checks.

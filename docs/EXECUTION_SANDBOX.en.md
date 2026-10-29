# Command and workspace-file sandbox

[English](EXECUTION_SANDBOX.en.md) · [简体中文](EXECUTION_SANDBOX.md)

Terminal, file-content I/O and local rg search share sandbox backends, resource admission and cleanup. Runtime owns authorization, version conflict detection and patch rollback; restricted processes do content I/O in the original project directory, without partitions, virtual disks or project copies.

Desktop/service enable an installed, successfully probed command sandbox by default; they do not download it automatically. This is not whole-application isolation or equivalent coverage to another product. Windows AppContainer and Linux bubblewrap have live tests; the documented Linux deployment used Ubuntu 24.04 and a real service account with NoNewPrivileges. Other distributions need acceptance. Detection is capability-based. macOS has no backend and rejects requested isolation.

## Setup and policy

Settings → Runtime → Command sandbox shows probe/install/toggle/recheck for the current host. Remote workers are configured on their own host/management channel. Distinguish missing, policy-blocked, available and unsupported. Startup/settings uses fixed harmless probes, never installs. Windows components ship with the app; repair/update if missing. Linux discovers trusted apt-get, dnf/dnf5/yum, pacman, zypper or apk without a distro-name allowlist. No recognized installer means a disabled install action, not rejection of an already usable bubblewrap.

Explicit install runs the fixed bubblewrap package command through the trusted manager, using OS authorization where available or showing the command for an administrator. It does not change repositories, AppArmor/SELinux, kernel or container policy. Package-manager availability is not sandbox availability: actual post-install probing is required. See [DNF5](https://dnf5.readthedocs.io/en/latest/dnf5.8.html), [SUSE](https://opensource.suse.com/bci-docs/guides/package-management/) and [Alpine](https://wiki.alpinelinux.org/wiki/Bubblewrap).

Successful installation saves config/sandbox.json (desktop product-host; service's own data). Explicit disabled preference survives restart/recheck. Auto policy applies to the next command; running or approval-pending commands retain immutable configuration. No schema/prompt/history changes, and a failure never silently switches isolation off.

```sh
node dist-electron/agentServiceCli.mjs --data-dir /srv/cardbush/worker-a --sandbox auto --sandbox-network disabled
```

Host environment settings require restart. Desktop also accepts `--execution-sandbox=auto`; CARDBUSH_EXECUTION_SANDBOX takes precedence. Auto is UI-adjustable, explicit off/required is administrator-locked.

| Variable | Default / semantics |
| --- | --- |
| `CARDBUSH_EXECUTION_SANDBOX` | Host installation/settings. auto isolates approval-mode commands, ordinary process in full access; required isolates every mode and refuses expansion; off explicitly disables command isolation. Standalone library without settings defaults off. Required isolation failure never falls back. |
| `CARDBUSH_SANDBOX_NETWORK` | disabled; enabled is backend-supported general network, not a domain allowlist. |
| `CARDBUSH_SANDBOX_READ_ROOTS` | JSON absolute-directory array, default []; additional read/execute roots. |
| `CARDBUSH_SANDBOX_WRITE_ROOTS` | JSON absolute-directory array, default []; additional write roots. |
| `CARDBUSH_BWRAP_PATH` | Trusted host PATH discovery or explicit absolute path, root-owned binary/ancestors without group/world writes; never model PATH/cwd. |

The current workspace is default writable; each command has private temporary HOME/config/cache. Real paths are resolved. Disk roots, Windows network shares, file-as-directory roots and broad roots containing sandbox management logs are rejected.

In auto, terminal additional_permissions can request read/write directories, existing individual files, or network. A single-file grant does not grant its parent/siblings/create/delete; use write_file to create a new file. Out-of-scope cwd requests directory write permission explicitly. Approval binds command, interpreter, real cwd, file identities and complete policy to this process tree only; subsequent commands return to base scope. Changes before/after approval reject admission. No approval means no launch; denial is not automatically retried. Network approval explicitly means all destinations, not a named-domain grant.

Required policy rejects impossible expansion before a misleading prompt; all_free, tool arguments, taskRoots/userRoots cannot override it. Off still requires exact approval for an unisolated approval-mode command. Windows auto includes the host-selected shell installation read-only. User-installed Node/Python needs its specific installation directory, not all of HOME. Commands do not inherit service/model/proxy secrets, NODE_OPTIONS, LD_PRELOAD or user startup config.

## Backend and environment facts

Terminal environmentDiagnostic distinguishes command lookup failure, access denial and unknown cause. A structured PowerShell command-not-found result can trigger one host metadata lookup for a simple executable name in absolute PATH directories, without executing/installing/granting it. Not found, Test-Path false or a failed venv does not prove host installation damage; first inspect scope and request a precise tool/interpreter directory when needed. Diagnostics never enable fallback host execution.

Windows uses a fresh AppContainer identity per command and separate directory capabilities for prepared ACL scope reuse. Only currently authorized capabilities are passed; network is separate and child processes inherit isolation. No network capability means socket denial. Create suspended, attach existing Job Object limits, then run; no admin bootstrap or disabling Smart App Control. This is AppContainer, not a dedicated low-privilege-user design.

Linux probes user/process/IPC/UTS/required-network namespaces as the service account using a fixed harmless Node program. Commands bind system tools/config read-only and workspace at its original path, not host /, real HOME or /run. Explicit read roots handle non-FHS tools. No extra seccomp filter or Windows-equivalent resource-quota claim. AppArmor/SELinux/container denial remains denial. The [AppArmor example](deployment/cardbush-bwrap.apparmor) is specific to `/usr/bin/bwrap` on Ubuntu and is never auto-installed; prefer distro rules and [Ubuntu guidance](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/), not a policy bypass.

Plain SSH cannot be isolated by the client: required policy refuses SSH terminal_exec/terminal_write without a remote sandbox handshake, retaining query/stop. An independent worker can enforce its own server sandbox. HTTP/SSH is transport, not isolation, and local grants are not inherited. Terminal sandbox metadata describes requested backend/network, independently of resource limits.

Windows requires PowerShell 7 without fallback to Windows PowerShell 5. Authorized cwd is initialized before user code; if drives are hidden, load only the selected shell's basic module and create CardBushWorkspace: without parent-directory grants. Native programs use `(Get-Location).ProviderPath`. Diagnostics reuse that path rather than reparsing unauthorized ancestors. Fail before user code if initialization fails. Phases are preparing_sandbox/executing/cleaning_up/finished, with setup/cleanup distinct from computation.

## Lifecycle and resource control

ACL modifications serialize per execution account, including overlapping/nested projects. Exact normalized read/write roots plus native version identify reusable directory grants; keep at most eight idle grants, reclaim after 60 seconds. Temporary expansion is never inherited. Initial prepare/final revoke may walk inherited ACLs; repeated commands reuse preparation. Native host handles pin directories/ancestors, without passing those handles or parent grants into the sandbox. Closing terminals/Runtime waits for cleanup.

Account-wide scope generations coordinate Runtimes and Windows logins in host-only `HKCU\Software\CardBush\SandboxScopeGeneration`. Moved files can retain ACLs: stale capabilities must never be issued again. Check before token creation and use a fresh one-use identity if stale, invalidating reuse without rerunning commands. Existing commands retain original grants. Read-only helpers and content-only single-file edits do not change generations. Concurrent differently scoped directory writers prevent cached grants and invalidate overlapping cached generations when ending; unknown process liveness fails conservatively. Native `sandboxScopeVersion:3` is required; restart old shared Runtime/App to load it, not merely a new CLI connection.

File/rg I/O has a separate maximum-two-process pool, 256 queued requests and cancellation. Terminal has its own quota; all share memory/CPU/process limits. I/O reserves 64 MiB without lowering system reserve. Resource denial never falls back. Queue time does not consume execution timeout; setup and cleanup each have 120-second bounds and distinct error codes. Stopping an already-exited terminal only collects its result, without fresh permission; active stop keeps its existing approval boundary.

Cleanup removes only this command/capability, never restores an old whole ACL over another session's changes. If native finally cannot run, Runtime starts cleanup. Failed cleanup retains cardbush-sandbox-*/policy.json or cardbush-scope-*/policy.json. Scope owners run outside the parent's automatic child cleanup group and detect Runtime death through a fixed process handle/stdin EOF. An unexpected scope-owner exit terminates dependent commands and triggers compensating cleanup.

Power loss or killing Runtime and every native helper simultaneously is not automatically recovered. Random identities are not reused, but ACL/profile remnants may remain. After confirming the task stopped, maintainers can run the matching-version helper with `--sandbox-cleanup <policy.json>` or `--sandbox-scope-cleanup <policy.json>`. Do not delete live logs or restore whole-project ACLs.

Native builds create immutable versioned files and check --capabilities before switching the manifest; failed starts/incompatible versions retain the old manifest. Signing/application control remains a release requirement, not proven by a developer-machine pass.

## Mandatory file-content boundary

Local read_file/write_file/edit_file/apply_patch/search_file_content always use restricted process I/O with network off. Terminal off/all_free does not disable this boundary. Missing backend, old single-file support, resource denial or blocked start fails explicitly; no host Node/content/search fallback. Approval binds real target and identity across queuing; change returns workspace_authorization_changed. Validate every patch source/destination before first content write; retain locks, read-version evidence and rollback.

Windows workspace-path-guard pins metadata paths/ancestors and rejects reparse replacement. workspace-file-worker reads/writes inside AppContainer using exact-file ACLs; `sandboxFileVersion:2` is required. Linux pins directory/file descriptors against inode reuse; a fixed sandbox-side launcher checks identities after bubblewrap mounts before starting rg/file worker/approved command. The worker checks after opening, then SHA-256 before truncating/writing through the same handle. Writable files with multiple existing hard links are refused. Exit releases handles and ACLs.

Create/delete need namespace operations: a narrow trusted broker handles approved exact names without granting a whole parent directory or doing content I/O. It is a fixed authorized path, not a failure fallback. Exclusive creation retains identity; launch failure removes only its own still-empty file. Windows deletes through a fixed sandbox handle with hash validation and exclusion of replacement. Linux atomically stages into a private same-filesystem directory, then validates/deletes inside isolation; failed recovery never overwrites a concurrently created replacement and reports the staging location. Cross-filesystem delete returns workspace_atomic_delete_unavailable, not unsafe unlink. Failed patches may leave empty directories and must not claim all effects were removed. Probe backend support before namespace changes.

Image injection, remember_source/file and ordinary file undo/restore use the same path, identities, approval and queue checks. External files get individual grants. Undo keeps recorded original path, locks and conflicts, rejecting redirected parents. Git checkpoint undo modifies selected paths through this boundary, not a host-wide Git scan. Immutable snapshots/Git objects/transaction logs remain trusted storage, not I/O fallback. Without a checked-link write backend, symlink restores/task copies fail before modifying files.

Root grants include dev:ino and native handles; directory replacement invalidates old authorization and reuse keys. Trusted Git resolves only explicit CARDBUSH_GIT_PATH or absolute host PATH directories, excluding workspace/cwd/relative entries. Invalid explicit configuration returns git_unavailable. This grants no terminal Git/Python/npm access and installs nothing; trusted repository management is not all sandboxed. Worker normalizes Windows PATH aliases and preserves explicit CARDBUSH_GIT_PATH/CARDBUSH_RG_PATH without widening command scope.

Enabled/discovered Skill SKILL.md and references may use existing file tools without repeated approval, but not scripts, installation roots, writes or terminal. Disabled/removed/out-of-package links gain no resource grant. Real-path and file/directory identity checks remain. An unchanged directory read returns EISDIR, while actual replacement reports changed authorization.

get_user_directories queries host-account metadata, using a fixed Windows native entry for actual/redirected home/desktop/documents rather than AppContainer USERPROFILE. It takes no path, reads no contents and changes no ACL. Results explicitly say accessGranted:false. Other platforms return confirmed home and mark unknown directories unavailable.

Search runs trusted absolute rg inside isolation: directory read grants or exact-file grants plus separate program execute/read. Explicit CARDBUSH_RG_PATH takes precedence; otherwise fixed package paths/absolute host PATH. Reject workspace programs, relative entries and bare commands. Invalid explicit config fails. Disable external config and parent/global ignore files, retain output/time/resource limits and rg matching semantics. Missing rg returns workspace_search_unavailable; no automatic install or host traversal fallback.

## Tests and remaining limits

```sh
npm run build --workspace @cardbush/bush-runtime
node --test packages/bush-runtime/test/commandSandboxPolicy.test.mjs packages/bush-runtime/test/commandPermission.test.mjs packages/bush-runtime/test/commandSandboxLive.test.mjs packages/bush-runtime/test/executionSandbox.test.mjs packages/bush-runtime/test/windowsSandboxScope.test.mjs
```

Live Windows tests cover exact ACL/read/write/sibling/junction boundaries, children/sockets/environment, concurrent scopes, denial/stop/cleanup. Linux requires actual bubblewrap under the service account; missing backends are not successful live acceptance. Optional CARDBUSH_SANDBOX_LIVE_NETWORK=HOST:PORT probes host reachability and deny/allow/deny TCP without application data; absence is reported skipped. FileBoundaryRegression, sandboxArchitectureReplay, processAdmission and resource-coordination cover rollback, source/image/undo/trusted programs, concurrent scope escape, stale canceled request IDs, helper crash and queue cleanup.

Background scripts pause execution timing for the union of approval waits while retaining CPU/memory/call/tool limits. CLI rechecks pending interactions/terminal state, handles expired answers without exiting or resubmitting, and preserves cursor/output on observation failure. Only confirmed task failure is shown as failure. Generic preapproval does not grant later operations; actual calls authorize concrete arguments. Existing shared Runtime must stop/restart to load code changes.

Known limits include broader Linux validation, release signing, power-loss recovery, protected configuration and pre-existing hard links, language-runtime compatibility and large-tree ACL costs. Public AppContainer-readable system resources and sensitive files already within the authorized project are not automatically hidden. Plain SSH file tools use their remote protocol, not local AppContainer. Browser/plugin installation does not establish connectivity; inspect actual status, never auto-switch or replay uncertain operations.

Hooks, stdio MCP, browsers, Computer Use and other helpers need separate isolation work. Do not advertise all tools as sandboxed. Dated tests, benchmark timings and private-session replay conclusions remain in the [original report sections](EXECUTION_SANDBOX.en.md), with skips/platform limits intact. See [design boundaries](EXECUTION_SANDBOX_PLAN.md) and [Microsoft AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer).

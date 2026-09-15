# Process resource protection

Windows managed command execution runs through the bundled `CardBushProcessHost` supervisor.
The shell is created suspended, attached to a shared Windows Job Object and a task
Job Object, then resumed. Failure to establish protection refuses execution; it
never silently falls back to an unrestricted launch. No tool arguments can raise
or disable the host's budgets.

## Default policy

| Resource | Policy |
| --- | --- |
| Task memory | Committed-memory cap for the whole task tree: 25% of physical RAM, further reduced by available memory at admission |
| Shared memory | Desktop main and Runtime managed trees share one native cap of 50% of physical RAM. Admission also deducts measured Electron main/Runtime/renderer memory and unconsumed startup reservations |
| CPU | Shared hard cap of 80%; below-normal process priority lets foreground work take precedence |
| Processes | 64 per task tree; 256 across the shared job |
| Concurrent managed commands | At most 8 across desktop main and Runtime; shared across sessions, forks, subagents, hooks and terminals |
| Persistent MCP services | At most 32, separate from command slots. A serialized replacement may transfer its old service slot; it still reserves startup memory before retiring the old tree |
| Memory admission reserve | 10% of physical RAM, bounded to 512 MiB–1 GiB. Tasks reserve 256 MiB and services 128 MiB for startup (clamped to their granted cap); this is not an estimate or limit of the plugin's total demand |
| Critical memory backstop | Sample every 2 seconds. After two critical physical/commit-memory samples, first relieve a substantial local preview, otherwise one substantial managed task (then service); remeasure for at least 6 seconds before another intervention |
| Disk pressure backstop | Every 2 seconds, check the working and temporary volumes; stop when free space is below 512 MiB and has fallen by over 8 MiB during the task |
| Terminal output | Existing 1 MiB per-stream pending-output limit remains in force |

The memory limit is Windows committed memory, not an exact RSS limit. Windows peak
job accounting can include an allocation attempt that was subsequently denied.
Tests verify successful committed/touched allocations and the rejected allocation,
instead of assuming the peak counter must stay below the configured cap.

Normal short commands still run concurrently. Native process-exit notifications
wake the supervisor immediately; they do not wait for the two-second watchdog.
There is no host process enumeration or WMI/PowerShell monitor. One small native
sampler queries only known Job Objects; Electron's own process metrics are cached
for two seconds. Short commands ending within 500 ms do not start the sampler.
The helper is compiled during build, never at tool execution time. An event-driven
native notification thread handles task memory/process-limit violations.
The native shared ceiling is fixed to physical RAM, rather than an old free-memory
sample. New admissions subtract live usage and reservations, so persistent MCP
connections no longer freeze all later tasks at the initial low-memory budget.
Each running tree retains its granted individual ceiling for its lifetime.
Native executables have immutable content-versioned names. An atomically updated
manifest selects a complete version for a new Runtime; an existing Runtime pins
its selected version. Protected builds and updates do not overwrite a live helper.

Memory and CPU limits are kernel-enforced. The disk and system-pressure checks
are best-effort backstops, not hard disk quotas. They cannot reserve resources
against unrelated programs or account for arbitrary output on other volumes.
A large-table plugin should additionally enforce its own scratch/output quota,
stream XLSX shared strings to disk, bound query previews, and set task deadlines.
Persistent terminals deliberately have no arbitrary wall-time cutoff.

## Lifecycle and compatibility

- `terminal_poll` and `terminal_write` retain their existing contracts; cancelling
  a wait leaves the terminal available. `terminal_stop` ends its whole task tree.
- Detached descendants end when the owning shell/session ends. Background work
  that must persist should keep the terminal root alive and retain its session ID.
- A crashed/killed supervisor closes its non-inheritable job handle and Windows
  kills the task tree. The supervisor also watches a pinned handle to its Runtime
  parent, cleaning up when the Runtime exits.
- `resource_memory_limit`, `resource_process_limit`, `resource_memory_pressure`,
  `resource_disk_pressure` and protection-startup failures return explicit failed
  terminal states. Shared-budget allocation denial may also surface through the
  child program's nonzero exit and stderr. Reduce workload/concurrency before retrying.
- The desktop Runtime acquires/releases leases through the existing private host
  RPC. Main-process helpers use the same governor and native group. Worker exits
  retain reservations for three seconds while the pinned-parent native cleanup
  completes. Standalone runtimes retain a local governor.
- Externally hosted HTTP/SSE MCP servers, credential helpers, external apps and
  independently launched browser services are outside this integration. Owned
  stdio MCP trees are covered, including their ordinary child processes. The OS "Open with" chooser deliberately
  launches independent applications. Synchronous Git/registration helpers and
  renderer image decoding remain outside the native managed-job cap. Local webview
  previews have best-effort per-process/combined memory relief; this is not a hard
  renderer heap limit. Future workers must use
  the managed execution API; adding a Skill alone does not enroll them.
- The native guard is Windows x64. Other platforms currently have admission
  accounting only, not equivalent OS memory/CPU limits.
- For WSL, the Windows launcher is managed; these Job Objects do not impose
  memory/CPU limits inside the Linux VM.

## Managed launch coverage and ownership

`@cardbush/bush-runtime/processes` is a lightweight launch entry point. It preserves
environment variables, arguments, stdin and exit codes. Windows launches always
use the native guard, with no unprotected fallback. A `ManagedProcessScope` tracks
pending starts as well as running trees, rejects new launches after closing, and
waits for its processes to exit. Cancellation is checked again after asynchronous
startup preparation. Unix cleanup kills the owned process group (best effort).

| Entry | Lifetime / cleanup | Output retained in memory |
| --- | --- | --- |
| Agent terminal / search | Existing terminal session / search call; cancelling a terminal wait still preserves the terminal | Terminal: 1 MiB per stream; search: existing 2 MiB per stream limit |
| Plugin Hooks / command hooks | Calling operation's abort signal; existing hook deadline; whole tree ends at root exit | 256 KiB combined by default; overflow stops the tree |
| Stdio MCP servers and their descendants | MCP connection owner; explicit disconnect, applied disable/removal, replacement, or application shutdown | SDK's bounded newline protocol reader; stderr continuously drained |
| UI terminal | Owning renderer; explicit close, reload, crash or destruction stops its tree | Streamed to the renderer; no main-process history accumulation |
| UI one-shot terminal command | Owning renderer and app | 80 KiB combined rolling tail during execution; return keeps up to 20,000 characters per stream and exposes `outputTruncated` |
| Plugin acquisition Git/npm commands | App-owned acquisition operation; 60-second deadline; cleanup waits for command exit | 4 MiB combined; overflow stops the tree |
| Blender model preview | Preview request cancellation/disposal and app; existing conversion deadline | 24 KiB combined rolling tail; error displays up to 6,000 characters |
| Office compatibility preview | Protected worker, 512 MiB tree cap, request cancellation and a 20-second deadline | 24 MiB combined output limit |
| Windows clipboard file helper | App; 5-second deadline | 16 KiB combined; overflow stops the tree |

All Electron command entry points above share one app scope. Closing one window
only aborts that window's terminal calls; application shutdown closes the app
scope. Task completion never closes an unrelated window's terminal or a shared
MCP/browser service. The main process resolves the packaged native asset outside
asar just as the Runtime does. Truncation is applied as bytes arrive, before data
is retained, rather than after an unbounded string has accumulated.

### MCP service lifecycle

The stdio transport starts its server through `ManagedProcessScope`. On Windows,
a small Node launch adapter preserves the SDK's PATH, `.cmd`, argument and
environment semantics inside the native job. It stays alive with the server;
neither it nor the server is restarted for individual tool calls. Startup still
requires a successful MCP handshake and complete tool discovery.

Close first sends stdin EOF and allows one second for cooperative shutdown, then
stops the owned tree and awaits termination. Repeated close calls share the same
completion. Startup cancellation and late SDK completions cannot leave a process
behind. The native parent-handle/job cleanup also applies if Runtime crashes.
No process-name/port search or per-tool process scan is performed.

An owned service replacement waits for the active-turn boundary, reserves startup
resources, closes its old tree, and only then starts its replacement. Resource
shortages publish `waiting_for_resources`, not a failed update. The current
connection remains usable while waiting. Admission is retried after two seconds,
outside the MCP handshake deadline and without holding a discovery slot. Disabling,
superseding or closing cancels this work; recovery cannot resurrect a cancelled start.
Superseded startups are serialized by
server ID within their manager. This avoids competing for the old service's port.
A failed replacement is unavailable until reconnected; it cannot keep an old
process alive as an atomic rollback. HTTP/SSE connections retain their existing
connection-only behavior and never terminate an external server.

Automatic recovery uses exponential backoff, capped at three actual restart attempts
until a connection stays healthy for 60 seconds. Manual reconnect creates a fresh
budget. Waiting for resources does not consume restart attempts. This only recovers
the connection; completed or interrupted business/tool calls are never replayed.
Closing the owner cancels recovery, including its backoff wait. Ordinary
turns share their application's connections. Explicit plugin-Agent MCP scopes
retain separate sessions; closing one scope never closes a sibling, while closing
the application owner also closes remaining scopes.

This covers connection/configuration updates. It does not provide an independent
daemon declaration or coordinate replacement of plugin package files on disk.
Plugins starting OS services, scheduled tasks, containers, or processes outside
the managed tree need an explicit ownership integration. Unix process-group
cleanup remains best effort, without the Windows crash/resource guarantees.

## Preview memory

Local files and media ranges stream from open file handles, with 64 KiB chunks
and an explicitly byte-sized 128 KiB response queue. HEAD does not read the body,
and cancellation closes the stream. Growing files cannot extend that response.
Office preview checks only bounded ZIP directory metadata before decoding:
32 MiB compressed, 128 MiB declared expanded, 32 MiB per entry, 10,000 entries.
Large/ZIP64/encrypted/invalid documents remain available as files; the preview
reports why it did not load them. This is a preview limit, not a file editing limit.
Compatibility Office parsing runs outside main in the protected worker. The full
visual renderer remains in its isolated webview. Local preview processes are
relieved above min(1 GiB, max(256 MiB, 8% of RAM)), combined previews above
min(2 GiB, 15% of RAM), or sustained critical pressure. Processes shared with a
conversation or a remote browser tab are never selected. The existing local
preview failure/retry UI handles the guest exit without replacing the app screen.
These periodic renderer checks are best effort; arbitrary images/GPU allocations,
external programs and WSL still cannot be given an absolute app-wide OOM guarantee.

## Runtime file operations

`read_file`, existing-file snapshots for `write_file`/`edit_file`, and the Node
search fallback use bounded reads (8 MiB per file). A stat permits fast rejection,
and streamed reads enforce the bound even if a file grows after the stat. Larger
text files can still use ranged reads; selected text is bounded to 2 Mi characters,
including a single extremely long line. Full-file SHA-256 remains streaming.
Oversized writes and replacement expansion fail before mutating the file.
The Node search fallback reports skipped oversized files as an incomplete search.
Native search also uses the managed process path, a 30-second search deadline,
and a 2 MiB output limit. Truncated/interrupted searches explicitly report that
their results are incomplete; a missing search executable can still fall back
to the bounded Node reader.

## Workspace checkpoints

Files larger than 8 MiB are written to Git directly using `hash-object -w` with
`core.bigFileThreshold=8m`; their bytes never pass through Runtime's fast-import
buffers. Hash verification still detects concurrent file changes. Review queries
object sizes first and omits content diffs above 128 KiB, retaining the Git object
identities. Small diffs are materialized in bounded batches.

Until streaming restore is implemented, a restore/copy operation whose requested
Git blobs total more than 64 MiB is refused **before file mutation**, with
`workspace_resource_limit`. Its files and Git versions remain intact. This also
applies to provisioning a worktree with a large baseline; direct mode can record
large artifacts without loading them into memory. This is an explicit current
limit, not a claim that all large-workbook editing and restoration is implemented.

## Validation

```text
npm run build:runtime
npx tsc -p tsconfig.node.json
node --test packages/bush-runtime/test/processResourceGuard.test.mjs packages/bush-runtime/test/workspaceTools.test.mjs packages/bush-runtime/test/managedProcessCommand.test.mjs scripts/test-host-processes.mjs
node --test packages/bush-mcp-client/test/resourceAdmission.test.mjs scripts/test-resource-coordination.mjs scripts/test-office-preview-resources.mjs
node scripts/test-plugin-acquisition.mjs
node scripts/test-plugin-extensions.mjs
node scripts/benchmark-process-resource-guard.mjs
electron scripts/test-process-resource-electron.cjs
```

Native tests use low quotas and bounded fixtures, including an allocation fixture
that cannot commit more than 512 MiB even if the guard regresses. Coverage includes
task/shared memory, process count, CPU throttling, a 24 MiB disk-pressure fixture,
stdin, Unicode/quoting, exact exit codes, stop, Runtime-parent exit, orphan cleanup,
admission sharing, failed startup and continued short-command responsiveness.

Benchmark alternating direct and guarded launches after two warmups. Report the
median and p95 rather than assuming the supervisor has no cost; each command pays
one launch cost, while output/poll calls do not start another supervisor.

Platform references: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[memory limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information),
[CPU rate control](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information).

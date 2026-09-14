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
| Shared memory | All managed tasks in one OS host process share at most 50% of physical RAM, reduced to available RAM minus the reserve when an idle host starts new work |
| CPU | Shared hard cap of 80%; below-normal process priority lets foreground work take precedence |
| Processes | 64 per task tree; 256 across the shared job |
| Concurrent managed commands | At most 8 per host process; Runtime admission is shared across sessions, forks, subagents, hooks and terminal managers |
| Memory admission reserve | 10% of physical RAM, bounded to 512 MiB–2 GiB; insufficient available memory refuses new work |
| Critical memory backstop | Every 2 seconds, stop a substantial task if available physical memory drops below min(512 MiB, 2.5% of RAM) |
| Disk pressure backstop | Every 2 seconds, check the working and temporary volumes; stop when free space is below 512 MiB and has fallen by over 8 MiB during the task |
| Terminal output | Existing 1 MiB per-stream pending-output limit remains in force |

The memory limit is Windows committed memory, not an exact RSS limit. Windows peak
job accounting can include an allocation attempt that was subsequently denied.
Tests verify successful committed/touched allocations and the rejected allocation,
instead of assuming the peak counter must stay below the configured cap.

Normal short commands still run concurrently. Native process-exit notifications
wake the supervisor immediately; they do not wait for the two-second watchdog.
There is no periodic process enumeration, WMI/PowerShell monitor, or renderer work.
The helper is compiled during build, never at tool execution time. An event-driven
native notification thread handles task memory/process-limit violations.
The shared memory ceiling stays fixed while tasks overlap and is recalculated
when the host becomes idle, so each new task cannot claim the same free RAM again.
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
- The shared cap covers managed trees in **one OS host process**. Electron main
  and its Runtime utility process still have separate aggregate budgets; this is
  not yet one app-wide CPU/memory ceiling or an admission waiting queue.
- Separately launched MCP servers, credential helpers, external apps and browser
  services are outside this integration. The OS "Open with" chooser deliberately
  launches independent applications. Synchronous Git/registration helpers and
  renderer image/document decoding also remain separate. Future workers must use
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
| UI terminal | Owning renderer; explicit close, reload, crash or destruction stops its tree | Streamed to the renderer; no main-process history accumulation |
| UI one-shot terminal command | Owning renderer and app | 80 KiB combined rolling tail during execution; return keeps up to 20,000 characters per stream and exposes `outputTruncated` |
| Plugin acquisition Git/npm commands | App-owned acquisition operation; 60-second deadline; cleanup waits for command exit | 4 MiB combined; overflow stops the tree |
| Blender model preview | Preview request cancellation/disposal and app; existing conversion deadline | 24 KiB combined rolling tail; error displays up to 6,000 characters |
| Windows clipboard file helper | App; 5-second deadline | 16 KiB combined; overflow stops the tree |

All Electron command entry points above share one app scope. Closing one window
only aborts that window's terminal calls; application shutdown closes the app
scope. Task completion never closes an unrelated window's terminal or a shared
MCP/browser service. The main process resolves the packaged native asset outside
asar just as the Runtime does. Truncation is applied as bytes arrive, before data
is retained, rather than after an unbounded string has accumulated.

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

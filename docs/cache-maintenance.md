# Local storage maintenance

Settings exposes three operations. None removes project files, task workspaces, installed plugins/Skills, credentials, drafts, cumulative usage or provider-side caches. Browser localStorage/IndexedDB are not cleared wholesale; history deletion prunes only its conversation presentation caches.

| Operation | Owner and retention policy |
| --- | --- |
| Clear conversation history | One Runtime operation preflights all tasks before deleting any. Active tasks and independent workspaces block the operation. Bound automations are paused; their definitions and recorded results remain. |
| Clear logs | Uses the same paths as the application writer, plus the legacy product-host log directory. Removes old crash dumps/metadata after 24 hours; Crashpad database/settings are retained. New diagnostic logs rotate at 8 MiB, keeping three prior files. |
| Clear application cache | Reclaims unreferenced Runtime data, expired temporary directories and Electron HTTP/code/shader caches. Uses Electron APIs, including persistent partitions, without clearing credentials or application storage. |

## Runtime retention

`cacheMaintenance.ts` collects entries declared by the storage owners. It marks references from retained conversations, recovery checkpoints, automation plans/results and open MCP Apps, then follows references through retained execution journals. No secondary execution-fact database is written. Existing file-memo numbers are never reused: their small allocation/locator index remains, while unreferenced execution payloads are removed.

The owners cover events, tool executions, coordination state, subagent records, MCP App scopes/context/observations, plugin hook/background delivery state, image blobs, redo blobs and expired partial files. Child sessions follow their parent unless another retained source references them; children with independent workspaces remain protected. Image and redo hashes and cross-session memo links keep the underlying records reachable.

Maintenance excludes foreground turns, queued/admitted execution, app actions and active background work. It does not execute or infer a task's outcome. Ownership/read errors abort reference collection before the sweep; removal errors are reported as partial cleanup and can be retried. Filesystem links are not traversed. Journal ownership reads are bounded; retained journal bodies are streamed in 64 KiB chunks, and orphan bodies are not read.

Built-in captures now use the Runtime profile's `captures` directory. The product host also supplies the legacy built-in temporary capture directory for compatibility. Both retain referenced or less-than-24-hour-old captures. A user-configured screenshot output directory is never supplied to maintenance.

## Temporary directories

Marketplace previews expire after 30 minutes, including directories from an earlier process. Plugin import/install/acquisition and model-preview crash leftovers expire after 24 hours. Cleanup runs at application startup and during explicit cache maintenance. Live staging directories carry process ownership; current previews, other live owners, linked directories and any `previous` rollback backup are protected. The ownership file is outside installable plugin payloads.

## Extension rule and validation

New disposable storage must expose its owner, reference keys, bounded reference reader and removal method, register with Runtime or host maintenance, and add a real filesystem retention test. Keep user outputs and durable business data out of these collectors.

Run `npm run test:cache-maintenance`. The fixtures cover restart orphans, shared images/redo, cross-session memo links, child sessions, automation context retention, recovery, busy/preflight rejection, symlink boundaries, temporary leases and rollback backups, partial errors, a 96 MiB orphan journal, and a real isolated Chromium profile retaining cookies/localStorage/IndexedDB. Settings tests exercise the new entry, busy state, error feedback and both themes. All destructive test paths are freshly created fixtures; tests do not clear the running product profile.

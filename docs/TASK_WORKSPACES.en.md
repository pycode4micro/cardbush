# Local, Worktree and file versions

[English](TASK_WORKSPACES.en.md) · [简体中文](TASK_WORKSPACES.md)

[中文](TASK_WORKSPACES.en.md) | [Documentation](README.md)

CardBush has Local/Worktree execution modes and stores Git-workspace file versions in Git objects. Code, documents, sheets, images and configuration use the same mechanism. The design draws on public execution/Git concepts, not a claim to reproduce another product's private per-Turn snapshot implementation.

## Usage

- New tasks default to **Local** in the selected project directory; no workspace-detail bar appears above the chat.
- Open Inspector Review → workspace operations for branches, repository creation, applying a task copy or restoring checkpoints. Project conversations can open review without changes; workspace reads happen on opening it.
- **Worktree** is explicit and requires a repository root with at least one commit. A detached-HEAD copy includes uncommitted changes and nonignored new files without changing the original branch, HEAD or index.
- Local at a Git root records per-Turn terminal/script/file-tool changes, even before the repository's first commit.
- Ordinary folders stay Local without hidden repositories. Create Git repository initializes in place and enables future versioning without creating a commit.
- Repository subdirectories, missing Git or incompletely versionable directories still support Local with existing file-tool undo. Terminal versioning is not claimed; the actual limitation is shown.
- Existing worktrees keep their execution path. Legacy `auto` means Local for new tasks, without moving active copies.
- Apply to original applies reviewed file changes only, without commits/staging/branch moves. Discard removes only that task's worktree, not the source directory.
- An unstarted worktree without task changes can switch to Local. Full bidirectional handoff, a staging panel and per-hunk acceptance are not implemented.

## Versions and execution facts

- Review shows a lazily loaded directory tree for the actual project/worktree, or `task_workspace` without a project: 200 entries per page, visible-row rendering, unchanged/dot/dependency files included, Git internals excluded, directory links not followed. Selected-Turn deleted paths are added; outside-directory changes have a separate branch.
- One toolbar switches current/previous Turn, counting Turns without changes. File selection persists; absent diffs show current content explicitly.
- Git checkpoints retain only the last two Turns, including active work, and old state shrinks to this window. Runtime rejects old undo/redo even through historical cards/requests. Baseline, applied/latest/reviewed versions and unfinished transactions remain protected.
- Tool history is not rewritten. Older in-memory rollback bytes/diff bodies are released; review diff cache is 8 MiB/eight entries rather than whole-session copies.
- Blobs retain original bytes; trees retain paths/types/executable bits. `refs/cardbush/workspaces/<task-hash>/snapshots/<tree>` keeps versions reachable in the existing object database.
- A separate temporary Git index is removed after use. No automatic commit enters user branches.
- `--no-filters` and batched object writes avoid newline, clean/smudge and encoding filters. Restore writes/verifies original bytes. SHA-1/SHA-256 repositories are tested.
- Each Turn records before/after trees. Transaction journals store tree references/affected paths rather than full JSON manifests. New writes no longer use separate legacy `blobs/`/`snapshots/` stores.
- `ToolExecutionRecord` retains actual calls, receipts and frozen model text. Version capture is not a fabricated tool call or evidence that the model read a scanned file.
- File tools omit separate old-content backups only when current-Turn Git coverage is confirmed. Ignored/outside-root edits retain their own evidence rather than disappearing under a checkpoint.
- Intermediate tool changes and final whole-Turn diffs represent different times; later edits/review/undo do not rewrite past facts.

## Historical and live review

`runtime.get_workspace` offers `view: history` and `view: live`:

- History reads stored checkpoints/Git objects without scanning/restoring the working directory; chat/history views use it.
- Live rechecks actual files/bytes for an applicable reviewed version. External changes require new review; stale review credentials cannot apply them.
- Read-only diffs can reuse an in-memory cache keyed by task, directory and before/after object IDs. Returned values are isolated; cache is neither persistence nor recovery authority.
- Unchanged content reuses objects/trees without new manifests. Byte verification remains; equal mtime/size is not proof of unchanged content.

Workspace operations compare against task start (last applied version for Worktree), not a general Git staging/branch/all-uncommitted-changes panel.

## Conflicts, interruptions and migration

Apply/undo preflight actual bytes, types and versions, persist transaction intent, then recheck each path before writing. Recovery touches only paths matching before/after transaction states. A third-party version is preserved and reported as a conflict. Atomic Git refs do not replace multi-file filesystem transactions, which remain Runtime's responsibility.

Known running terminals neither decide model completion nor independently block the next conversation Turn, but must exit before apply/undo/discard.

Legacy `bush.task_workspace.v1` reads validate original manifests/content SHA-256, import into Git and atomically switch to v2 references, including unfinished recovery transactions. Failure preserves old state; success does not proactively delete old recovery data.

Undo spanning Git-covered and uncovered tool changes rejects before any write rather than reporting partial success. Turns with only uncovered file-tool edits retain the existing undo path.

## Limits

- Coverage includes tracked files, nonignored new files and previously versioned paths. Explicitly included new tool paths remain covered in that Turn even if later ignored.
- Ignored dependencies/caches/environment files are not automatically copied. Binary/large files can be versioned, but inline full diffs above 128 KiB are omitted. Git supplies no automatic cell/paragraph semantic merge.
- Restore does not change HEAD, branches, user index, ACLs, extended attributes, timestamps or empty directories. POSIX modes follow Git executable-bit semantics.
- Submodules, non-UTF-8 paths and unsafe file types lack full workspace versioning; Local file-tool undo can remain.
- Versions depend on the original object database. Cleanup removes only expired private task refs, not branches/index/other sessions, and never forces Git GC. Normal Git collection handles unreachable objects; moving/deleting repositories needs separate handling.
- Worktrees are directories, not OS sandboxes; versions do not cover external-system effects.
- Capture/restore cannot lock external processes and is not an OS atomic snapshot. Crash tests construct interrupted disk state, not real power failures.

## Checks

- `npm run test:task-workspaces`: real temporary Git repositories, both modes, bytes/conflicts/interruption/migration/UI projections.
- `npm run test:app-views`: actual components in isolated Chromium.
- `npm run benchmark:task-workspaces -- --files 1000,10000 --turns 4`: local scale measurements, separately timing history/live reads, without paid models.
- Runtime/protocol suites, frontend/backend type checks and build.

CacheChain hashing uses the actual normalized Provider-bound request, preventing JavaScript property insertion order from looking like a prefix break while preserving strict content checks. Run large graphical/build/Runtime suites sequentially to avoid unrelated wall-clock assertions; do not relax checks to hide contention. The original [Git comparison](TASK_WORKSPACE_GIT_BENCHMARK_2026-09-06.md) and [baseline](TASK_WORKSPACE_BENCHMARK_2026-09-06.md) retain historical counts/timings, not current performance guarantees.

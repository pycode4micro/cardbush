# Renderer responsibilities and regression evidence — 2026-09-30

## Scope

This pass separates persistence, UI leaves, inspector lifecycle and style ownership from the renderer composition root. It preserves runtime protocols, request construction, cache-chain behavior, settings keys and defaults. Existing calendar, composer-presentation and multipage-resize changes from the preceding work are retained in the same delivery.

`src/App.tsx` drops from 3959 lines to 2870. It continues to compose navigation, chat state and host capabilities; it no longer implements the extracted stores and leaf views. This is a bounded renderer refactor, not a rewrite of the runtime or Electron host.

## Ownership

| Module | Responsibility |
| --- | --- |
| `src/features/settings/appSettingsStore.ts` | Defaults, normalization and persistence of application settings; secret redaction |
| `src/features/settings/modelPreferences.ts` | Model preference decoding, normalization, credential migration and selection |
| `src/features/settings/localPreferences.ts` | Language, sidebar, skill and visual-input preferences |
| `src/features/appearance/themePreferences.ts` | Legacy theme migration and initial theme selection |
| `src/features/sidebar/projectStore.ts` | Project identity, local storage and deduplication |
| `src/features/sidebar/ProjectRenameDialog.tsx` | Rename dialog lifecycle and validation display |
| `src/components/AppErrorBoundary.tsx` | Renderer failure reporting and fallback |
| `src/components/CopyToastHost.tsx` | Copy-feedback subscription and dismissal |
| `src/features/panels/FeaturePanel.tsx` | Feature heading, lazy content and loading fallback |
| `src/features/inspector/useInspectorWorkspace.ts` | Inspector width, multipage layout, cover/input state, restore snapshots and event cleanup |

The inspector hook receives navigation and tab operations explicitly. It does not import `App`, the chat hook or runtime implementation. Preference modules can be exercised without mounting the application. The view regression harness rejects imports back into `App`, circular view dependencies and runtime-source imports, and guards against moving these implementations back into the composition root.

## Styles

`src/styles/app.css` is now an ordered manifest for 18 stylesheets. Each stylesheet owns a contiguous portion of the existing cascade: shell, sidebar, workspace, inspector, welcome, transcript, scenes, markdown, execution, runtime rail, composer, feature panels, settings, companion, dialogs, secondary surfaces, settings controls and responsive overrides.

The extraction reconstructed the original text before replacing the entry point. The 2990 top-level CSS nodes retain their order and content. Keep the manifest order: later overrides are intentional. Moving selectors across files must be treated as a style change, not as a mechanical cleanup.

`scripts/helpers/read-source-file.cjs` expands local CSS imports for Electron `insertCSS` fixtures and source contracts, matching Vite's ordered entry. Ordinary source reads retain their existing behavior. This avoids validating a nineteen-line manifest while silently omitting its styles.

## Validation

- Production build: `npm run build`; renderer type check: `npx tsc --noEmit -p tsconfig.json`.
- Extracted declarations: 50 functions/classes/constants compared with the original declarations; only exports and the relative lazy-import path changed.
- All 45 `scripts/*-contract.mjs` checks passed. Stale checks were updated to read current owners and current composer/workspace/media behavior.
- `scripts/test-app-preferences.mjs`: original storage keys/defaults, credential redaction and migration, project identity/deduplication, legacy themes and corrupt-data fallback.
- Inspector cover tests: pointer geometry, full-width tiles, 125% renderer zoom, cover/return, a single active composer and preserved widths. New hook tests cover declined beta prompts, two initial panes, menu closure, Escape ordering, restored section/sidebar/width and close/unmount cleanup.
- Lazy-module failure and retry: `scripts/test-deferred-modules.mjs` passed.
- Runtime package gate: 1301 cases exercised; 1290 passed initially, five POSIX/Linux cases were skipped on Windows, and six stale message-position expectations failed. After explicitly accounting for the existing internal `individuation_preference` user message, all 24 tests in the three affected files passed, including unchanged parent cache prefixes and tool order. Runtime implementation was not changed.
- Release checks were run in phases, continuing from completed stages after fixture repairs rather than repeating already passing package tests. Additional stale fixtures were updated for the current queued-send callback, native model dialog, `chat.queue` status watcher, managed-model shape and built-in component application entry. Agent model editing, credential/limit preservation, session switching, image attachments, disconnect recovery and plugin synchronization passed.
- Full shared chat view suite passed: module direction, StrictMode, file previews, send/stop, streaming, tools, scroll retention, queue interactions, sidebar resizing and both themes. Source memo and subagent conversation suites passed as well.
- Component/workspace tests passed: HTML isolation and SDK actions, drag/resize at 125% zoom, alignment guides, movable toolbar, hover previews, layout undo/reset/cancel/save, protected built-ins and persistent input styles.
- Composer presentation tests passed through actual welcome/send/stop transitions, preserving drafts and explicit conversation permissions. Page navigation, app center, Markdown tables, image preview, plugin connections/appearance and status indicators passed.
- Native Electron browser tests passed: retained webview guests, row/column dividers, pointer-up/cancel, CSS and renderer zoom at 125%, near-left docking, full-cover sizing/restore and selected-page external navigation. The fixture deliberately exercises conflicting browser-setting revisions and confirms the rejection.
- Calendar/automation UI tests passed: bounded hover details, fade/reduced motion, holiday import, live schedules, time-zone edits, pause/run/stop, retained conflicts and narrow layout. Runtime plugin replacement/uninstall passed with real MCP/extension cleanup and busy-work protection.
- Native window-menu and shortcut/navigation checks passed. The final renderer type check and Vite production build completed successfully after the last source edits.
- Two intermittent process observations remain in the validation record: a status-indicator test exited abnormally on Windows after successful assertions (`PostQueuedCompletionStatus`, invalid handle), and the uninstall fixture hit the existing 12-second runtime startup deadline once. Both isolated reruns completed with exit code 0; their causes were not established. Runtime startup/timeout behavior was not changed in this renderer refactor.

New preference tests and the component, inspector-cover, composer-presentation, page-navigation and native-browser fixtures are included in `scripts/run-release-tests.mjs` for future runs.

No live provider request or new MSIX certification is required for this renderer-only refactor. The production bundle still reports the existing large-chunk warning; reducing bundle size is separate from splitting source responsibilities.

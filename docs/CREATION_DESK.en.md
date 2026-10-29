# Persistent Creation desks

[English](CREATION_DESK.en.md) · [简体中文](CREATION_DESK.md)

[中文](CREATION_DESK.en.md) | [Documentation](README.md)

Persistent desks reuse `space.canvas.json`, file previews, region conversations and Team. They do not introduce another project type or execution system.

## Using a desk

- On a blank canvas, choose the CardBush development desk starter, or select it from More. After choosing the source folder, the desk still lives in the default workspace.
- The five initial regions cover recent changes, the next release, verification/issues, version comparisons and design/records. They explicitly await updates; they contain no invented progress or test results.
- Update desk prepares a request in the existing composer. Add requirements and send it; the Agent reads the source folder and records, then updates each region.
- Select a region to discuss it, freeze a version or resume updates. Finer file selections reuse Inspector region selection and conversation.
- Selecting a Team in More associates an existing workflow; it does not start or edit it. The Agent assigns regions and uses normal Team execution.
- Saving to a folder, extracting components and creating a conversation layout use existing exports.

## Content and layout

`design inspect` returns stable region IDs, content, purpose, groups, member assignments, version modes and revision.

Use `content: [{id, content: {kind, markdown | html | source}}]` for content updates. This preserves position, size, order, group, purpose and ownership. Changing existing frames or board dimensions requires `layout: true`, which an Agent uses only when the user requests rearrangement. Writes retain revision comparison and a cross-process file lock. On conflict, reread instead of overwriting newer changes with an old layout.

## Fixed versions

`freeze` captures an independent content version; `unfreeze` resumes its original source. Both require the item ID and latest revision. Ordinary saves and design updates reject changes to fixed content, but users can move or rename the region.

Local files and explicit dependencies are copied to `canvas-versions/<uuid>/`. Local Markdown images are included; ordinary external links remain links. Sources must remain consistent before and after capture. The fixed copy no longer depends on the original file existing. Unfreezing references the original again; a missing original is shown by the normal preview fallback.

Markdown dependency discovery follows syntax. Inline code, fenced code, escaped examples and unused reference definitions are not read as files; real images, links and reference-style images keep their dependencies. Freeze and export use the same logic. Missing real assets stop the operation so an incomplete version is not presented as complete; the UI shows an actionable file message.

The canvas shares a left baseline with the Creation title, name field and zoom controls. A thin border and grid show usable space. Zoom anchors to the canvas point under the pointer; fit restores alignment. Notification overlays do not enter size calculations or push/resize the canvas.

A fixed version captures source content, not a running web page's state. Save remote files/media locally first, or use a region screenshot; a remote URL is not marked as a frozen file. Agent copies use standard permission-checked, journaled file tools with an 8 MiB per-file limit. Direct desktop captures are limited to 128 MiB and 200 files. Other tools and original files remain independent: freezing is not OS write protection.

## Team

The existing `team run` action accepts `canvas_path`. Startup validates the canvas through design and persists assignments. Each member inspects the latest canvas through its own tools rather than calling an expired parent-turn callback. Read-only members use `read_file` and return findings without weakening guards or tool restrictions. Run and resume use the same Team/subagent lifecycle.

Members may update only content in assigned regions. The parent handles layout, freeze/unfreeze, deletion, ownership changes and changes spanning regions. Unassigned members return results for parent integration. Shared source files still require parent coordination; unrestricted sibling chat is not enabled.

## Verification

- `node --test packages/bush-runtime/test/design.test.mjs scripts/test-creation-canvas.mjs`
- `node --test packages/bush-runtime/test/teamWorkflow.test.mjs packages/bush-runtime/test/nativeTeamHost.test.mjs packages/bush-runtime/test/builtinToolDisclosure.test.mjs`
- `node scripts/test-creation-canvas-ui.mjs`

UI regressions use real Electron previews and file services. Native Team regressions use real child sessions and tools with deterministic model replies. They verify product behavior, not the content quality of every model.

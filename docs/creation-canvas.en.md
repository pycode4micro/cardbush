# Creation canvas

[English](creation-canvas.en.md) · [简体中文](creation-canvas.md)

[中文](creation-canvas.en.md) | [Documentation](README.md)

Creation is a multi-file workspace assembled through an Agent. The sidebar manages canvases, the main area displays content, and the composer uses the existing conversation, model, permissions and tools. Creating a canvas allocates a default task workspace; a conversation is created only on the first real submission. The UI does not divide canvases into project and temporary documents.

## Content and layout

`space.canvas.json` is the source of truth, using `cardbush-canvas` v1. It stores the board dimensions, background, stable item IDs and CSS-pixel coordinates. Items render from back to front in array order.

- `html`: the existing isolated component sandbox, with self-contained CSS, JavaScript and data images; no host privileges or network access.
- `markdown`: inline Markdown, with file references resolved relative to the canvas directory.
- `file`: an absolute path, canvas-relative path or web URL. The Inspector adapters display PPT/PPTX, XLS/XLSX, DOC/DOCX, Markdown, PDF, HTML, images, audio and video. Unknown formats use the ordinary file fallback.

A local file change refreshes only its preview. Moving another item or renaming the board does not reload interactive HTML. Board boundaries, dots and item outlines identify the workspace and individual regions. Drag the title bar to move an item; selection shows eight resize handles and dimensions. Handle size is independent of zoom.

Drag blank space to pan. The hand tool pans over file content; the middle button or holding Space while the canvas is focused also pans. The wheel pans over blank space; Ctrl/⌘ + wheel zooms around the pointer. Fit to window restores the centered view. Files retain their own scrolling and interactions.

Edges, center lines and board boundaries snap within 6 screen pixels while moving or resizing, with alignment guides. Alt temporarily disables snapping. With a title bar or handle focused, arrow keys move by 1 pixel and Shift + arrow by 10. Esc cancels the drag. Saving happens only after an actual geometry change; a newer manifest revision during a drag prevents overwriting it. Panning does not change saved layout, and drag previews do not reload files or HTML.

## Agent integration

Canvas conversations retain `creation_workspace` and add the `creation_canvas` manifest path. Each submission includes hidden editing context: layout, selection, viewport size and zoom. User message bubbles do not display this internal data.

The built-in `design` tool has four actions:

1. `inspect`: read the full manifest, SHA-256 revision, geometry and overlaps.
2. `update`: require `expected_revision`. Prefer `content` for updating an existing region while preserving layout. Use `upsert` for complete items, `remove` for explicit deletion, or update the title/background. Changes to existing frames or board dimensions require `layout: true`. IDs can be reused; removing and updating the same ID is rejected.
3. `freeze`: require the current revision and `item_id` to capture local content and dependencies.
4. `unfreeze`: require the current revision and `item_id` to resume the original source. See [Persistent Creation desks](CREATION_DESK.en.md) for ownership and version limits.

Existing tools and plugins still generate content and edit source files. `design` delegates to ordinary file tools, retaining permission checks, change records and recovery. It shares a file lock with desktop saves and rejects stale revisions. Invalid dimensions, out-of-bounds items, duplicate IDs and manifests exceeding 8 MiB fail before writing.

## Excerpts, components and saving

Use the file's region-reference action to hover over a block or drag a custom rectangle, then reference it on the canvas. An excerpt is currently a **snapshot**, recording the source file, page/sheet/cells, locator and text. It is not an automatically updating crop. A selection can also be sent directly to the same Agent conversation.

The More menu extracts selected content into a component, uses the canvas as a new conversation layout, or saves it to a folder. HTML components retain interaction. File-to-component conversion uses the current visible snapshot and existing component size/count limits. Conversation layouts retain the system composer.

Export creates a new independent directory containing the manifest and referenced local files. It recursively copies explicit HTML/CSS/JS/Markdown dependencies and rewrites relative paths. External pages still require network access; dynamically computed asset paths must be supplied by the content author. `index.html` displays HTML, images, PDF, audio and video. Open `space.canvas.json` in CardBush for Office files and the full canvas. Existing target files are not overwritten.

Legacy Creation documents migrate to file or Markdown items while retaining their original storage. Team's document editor continues to use its existing implementation.

## Verification

```powershell
npm run build --workspace @cardbush/bush-protocol
npm run build --workspace @cardbush/bush-runtime
npx tsc -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.json
npx vite build
node --test packages/bush-runtime/test/design.test.mjs scripts/test-creation-canvas.mjs
node --test scripts/test-canvas-geometry.mjs
node scripts/test-creation-canvas-ui.mjs
node scripts/test-inspector-regions.mjs
```

UI tests use isolated configuration, real previews, `design` and file services. Conversation network calls are stubbed; tests neither call a model nor access user history.

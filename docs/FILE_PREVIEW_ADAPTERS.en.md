# Maintaining file preview adapters

[English](FILE_PREVIEW_ADAPTERS.en.md) · [简体中文](FILE_PREVIEW_ADAPTERS.md)

[中文](FILE_PREVIEW_ADAPTERS.en.md) | [Documentation](README.md)

Inspector selects a registered preview capability. Unknown formats show filename, path and an Open in default application action. They are not read, decoded as text, turned into web previews or launched externally automatically. Extensionless files are automatically treated as text only for registered names such as README and Makefile.

## Adding support

1. Reuse a preview by updating `filePreviewAdapters` in `src/features/inspector/filePreviewRegistry.ts` with extensions/full filenames, renderer and resource URL. Matching is case-insensitive over the decoded local path. Duplicate extensions, filenames or IDs fail rather than silently changing selection order.
2. For a dedicated renderer, implement `InspectorFilePreviewProps`, register it in `src/features/inspector/inspectorFilePreviewRenderers.tsx`, then declare supported formats. Renderer types derive from that map; do not add format branches to `InspectorWebview`. Lazy-load heavy implementations with React.lazy.
3. Report loading through `onLoadingChange`; cancel stale requests and release resources. `FilePreviewFallback` can show parsing errors and external-open actions. `InspectorErrorBoundary` handles local failures. Do not reload the whole app.

This is a source-code maintenance interface, not a dynamic API for files/models to register arbitrary executable code. Adding an extension does not make an engineering project renderable. A local converter belongs behind a limited, read-only main-process file service, not in a page or text decoder.

## Boundaries

- The registry is the only UI format-selection table. It does not infer file contents or installed applications.
- Main-process file services retain reading, byte ranges and existing Office input validation; they are not a second UI format registry.
- The text decoder handles already selected text previews, retaining encoding, size and binary-byte checks against damaged/misnamed files. New application formats do not require decoder magic-number branches.
- Web URLs use the browser. Failed system-open operations show a dialog, not navigation or a main-window reload.
- Assistant file/folder paths resolve into clickable references only after a successful final response. Streaming/intermediate responses (including expanded history), failed and stopped states remain text without file metadata queries. User references, attachments and tool outputs keep their own behavior. This `MessageBubble` presentation rule does not rewrite history or model context. Markdown component identity remains stable across increments, avoiding repeated unmounts and flicker.

## Regression checks

Run `npm run test:markdown-preview`, `npm run test:text-preview`, `npm run test:app-views`, `npm run test:inspector-media`, `npm run test:model-preview` and `npm run typecheck`. New formats need matching/nonmatching paths; new renderers also need success, malformed input, stale responses after file switches and resource cleanup.

Run Electron graphical suites sequentially. Parallel local suites have previously timed out at process exit after assertions; sequential reruns passed. This does not justify ignoring shutdown timeouts: launchers still require clean exits.

## Read-only Blender adapter

`.blend` uses `model-preview.html` in a sandbox webview, keeping Three.js/WebGL out of the main UI. A background Blender process uses its official glTF exporter to produce a temporary GLB. Entry points are `electron/modelPreview.ts` and `assets/previewers/blender_preview.py`.

- View controls: orbit, zoom, pan, front/top/fit, wireframe/grid, object visibility, scene selection, animation play/pause/seek and file information. They never edit/save the source.
- Dependency discovery: `CARDBUSH_BLENDER_PATH`, then PATH, common Windows install directories and macOS app directories. No Blender GUI is needed. Missing Blender shows a dependency prompt; it is neither bundled nor automatically downloaded.
- Read-only conversion: `--factory-startup --disable-autoexec` and `open_mainfile(..., use_scripts=False)` prevent embedded automatic scripts. Outputs and script copies stay in a separate temporary directory. Conversion checks source file state afterward; real tests additionally verify unchanged SHA-256 bytes.
- Resource limits: two concurrent conversions, 120 seconds each; display limits of 128 MiB GLB, 3 million vertices and 20,000 nodes. Loaded temporary files are released immediately; unclaimed results expire after 5 minutes. Cancellation/exit terminate background processes. Rendering is on demand, with animation paused while hidden.
- Cancellation: each conversion has a random request ID. DELETE explicitly releases/cancels that ID, stopping preparation or removing its output. Fetch AbortSignal alone is insufficient because Electron custom-protocol handlers may continue. A bounded, short-lived release record prevents a delayed conversion request from restarting already cancelled work.
- Fidelity: geometry, PBR materials, lights, bones/morph-target animation representable by glTF. Procedural textures, simulations, volumes and some nodes/modifiers may differ. The UI reports detected limitations; the preview is not advertised as a full Blender render.

Format references: [Blender glTF exporter](https://docs.blender.org/manual/en/4.0/addons/import_export/scene_gltf2.html), [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html).

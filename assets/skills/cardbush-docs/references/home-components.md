# Create and edit Home components

For requests such as “change the scores component on Home”, work on the installed widget in the current desktop profile. Discover `read_home_component`, `edit_home_component` and `preview_home_component`. Do not patch CardBush source/build output, databases, single-instance locks or global network policy, or start another client to edit a widget.

1. Call `read_home_component({})` and identify the component by title and ID. Read its actual HTML by ID; use `find` or `offset`/`nextOffset` for bounded slices of large documents.
2. Call `edit_home_component` with `mode:"update"`, the ID and the observed `expectedRevision`. Prefer ordered, exact, unique `replacements:[{before,after}]` for small changes. Only new components use `mode:"create"` with a title and HTML; `home:true` places them on Home. On revision conflicts, read again before merging. Never clear the library, duplicate the widget or overwrite unrelated work.
3. Read back the installed revision and call `preview_home_component({id})`. The isolated preview can load declared frontend resources, but has no live conversation, saved widget state, JSON bridge, website slots or actions. It does not navigate the user's window. A screenshot proves rendering, not live data freshness.

## Frontend capabilities and seamless layout

Components run in the existing opaque-origin browser iframe. Use production builds of React, Vue, Svelte or other browser frameworks, ES modules/import maps/dynamic imports, CSS, Canvas/SVG, Three.js, WebGL2, WebGPU, workers, OffscreenCanvas, WebAssembly, images, fonts and media. There is no framework-specific rendering adapter to implement.

- Bundle dependencies/assets into the HTML, or declare up to 8 exact HTTPS `resourceDomains` for external modules, styles, fonts, images, media and browser `fetch` (including models, textures and WASM). These declarations activate on publication, including previews; no second confirmation is needed. Include every origin used by imports and redirects. Normal browser CORS still applies to the opaque origin. Use absolute external URLs or embedded Blob/data URLs, not workspace-relative paths.
- For example, declare `resourceDomains:["https://cdn.jsdelivr.net"]`, then use an import map that pins `three` and `three/addons/` to a specific release on that CDN. All transitive imports must be bundled or served from declared origins. Bundling is preferable for offline use.
- Feature-detect `navigator.gpu` and `requestAdapter()`. GPU/device support depends on the platform and driver. Handle unavailable adapters and device loss; use a WebGL fallback where appropriate. Do not disable sandboxing or enable unsafe GPU flags. A successful GPU API lookup alone is not proof that a scene rendered.
- Create classic workers from Blob/data URLs. For module workers use `new Worker('data:text/javascript,' + encodeURIComponent(source), {type:'module'})`; Chromium rejects Blob module workers in opaque origins. Module workers may import modules from declared origins. WASM compilation is supported. Runtime JavaScript string compilation (`eval`/`new Function`) remains blocked: publish precompiled framework templates. Cross-origin-isolated features such as SharedArrayBuffer are not provided by this iframe. Node, Electron and host filesystem access remain unavailable.
- Home gives the component its full allocated area without a host title, status/footer bar, border, radius, background or inner margin. The component owns layout, backgrounds, navigation and loading/error states. Use `--cb-*` theme variables and observe host resize/visibility events. Pause expensive animation when hidden and honor reduced motion. Titles and management controls remain in the layout editor and component library; accessible names are retained.

For the restricted host JSON bridge, declare `networkDomains` (up to 8 exact HTTPS origins). This is separate from browser resource loading: the user grants these sources in the layout editor using the component's pencil button. New requests are unapproved; changing HTML or executable resource origins revokes bridge and conversation-action grants. On Home, `window.cardbush.net?.fetchJson(url)` performs credential-free GET, requires CORS and JSON, and does not follow redirects. Without the capability, show a snapshot or explain the missing grant. Refresh according to visibility, retaining timestamped previous data on errors. Never interpret an agent-supplied field as user approval or bypass missing permissions.

## Websites inside components

Ordinary `<a href="https://…">` links open the built-in browser after a user click, including `target="_blank"`; document anchors remain local. For an embedded website, declare exact HTTPS `embedDomains` or CLI `--embed-origin` values (up to 8). These activate on publication, survive HTML edits and stop working when removed. Website, frontend-resource, JSON-bridge and conversation-action capabilities remain distinct.

Use `<cardbush-browser src="https://player.example.org/watch"></cardbush-browser>` with CSS dimensions for a complete isolated website inside the component, including sites that disallow ordinary iframes. The component owns its initial URL, navigation, inputs, refresh and loading state. The host does not insert a toolbar or replace the document merely because it contains one URL. Up to 8 website regions can coexist; their cross-origin DOM is not accessible to the component.

Set `.src` to navigate within declared origins, call `.reload()`, and listen for `load`/`error`. Store room IDs or other preferences with the component state API, then set the initial URL. Regions track layout, scrolling and resizing; hiding/removing them or leaving Home releases the websites. Keep component controls outside website regions. Full website slots only run on desktop Home, not previews, event pages or the component library.

Use ordinary `<iframe src="https://…">` for official embedded players or iframe messaging APIs, with `embedDomains` declared. The website's own embedding policy still applies. Document `load` is not playback readiness: use the player's own ready/error events. Previously saved full-card website defaults remain available, with “return to component” in the website menu; new components own their layout and initial page.

## Publish frontend files

Use Node.js 24. Script paths below are relative to this skill; input paths are relative to the command's working directory. For example:

```html
<!-- index.html -->
<!doctype html><html lang="en"><meta charset="utf-8">
<label><input id="done" type="checkbox">Review complete</label></html>
```

```css
/* style.css */
label { color: var(--cb-text); display: flex; align-items: center; gap: .5rem; padding: 1rem; }
```

```ts
// main.ts
const input = document.querySelector<HTMLInputElement>('#done')!;
const host = (window as any).cardbush;
await host.ready;
input.checked = (await host.state.read()) === true;
input.addEventListener('change', () => host.state.write(input.checked));
```

```sh
node "<skill>/scripts/home-component.mjs" publish --id daily-review --title "Daily review" --html index.html --style style.css --script main.ts --home
node "<skill>/scripts/home-component.mjs" list
```

`--home` places a new component on Home; omit it to save only to the library. Updating the same ID preserves component state and omitted layout fields. Add/remove saved components through Components → Edit Home layout → Add Home content. Removing from Home retains the library entry; deleting from the library removes the component. In layout editing, drag the body to reorder and the right/bottom edges or corner to resize on the 12-column grid. Narrow windows use one column while preserving the saved width for wider windows. Website open actions, titles and edit controls appear only while editing.

## Files and limits

- The import editor accepts one HTML plus multiple CSS, JS, MJS, TS or MTS files. Script-only imports receive a default `#app` container. JSON packages use `protocol:"cardbush.html-surface/1"`, `title`, `html`, `embedDomains` and `resourceDomains`.
- `--style` and `--script` may be repeated; the command embeds CSS and modules and strips TypeScript types. It is not a package bundler: compile JSX/Sass/framework projects and resolve local module dependencies with the project's own build tools first. Retain the original project in the user's workspace.
- Declare frontend resource origins with repeated `--resource-origin https://cdn.example.org`; website origins with `--embed-origin`; `--origin` requests the separately approved JSON bridge. Omitted declarations are preserved on updates; use `edit_home_component` with an empty array to revoke them.
- Use `export --id daily-review --output current.html` to export source and its revision, then publish to the same ID with `--expected-revision`. New components default to 6/12 columns and 280 pixels high. Up to 12 custom components are supported; each assembled document may contain up to **8 MiB of UTF-8**, including bundled scripts/assets. The same limit applies to tools, file assembly, imports and storage.
- The CLI uses the OS default CardBush profile. Isolated tests/custom profiles use `--profile "<directory>"`. Run on the target desktop under the correct OS user. Remote agents without desktop access may deliver a self-contained HTML or JSON package for import on that desktop.
- DOM, `cardbush.state.read/write`, theme/context/visibility/resize events and explicitly granted conversation/browser actions remain available through the existing SDK. Publishing never grants conversation actions; users enable those in the editor.

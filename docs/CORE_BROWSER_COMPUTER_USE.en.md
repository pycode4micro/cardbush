# Browser Use and Computer Use boundaries

[English](CORE_BROWSER_COMPUTER_USE.en.md) · [简体中文](CORE_BROWSER_COMPUTER_USE.md)

The Windows Browser Use implementation controls actual CardBush tabs and separately paired Chrome/Edge profiles. External browsers retain their extensions, sign-in and personal settings. These core capabilities ship with the app. The supported/tested native integration described here is Windows 11; optional Linux worker graphics is a separate deployment.

## Integrated tabs and ownership

Reference `@ → CardBush browser` to bind the exact window/tab/guest identity to the conversation, never a matching URL in another browser. `list_pages` identifies CardBush pages and the same snapshot/click/type/navigation/screenshot vocabulary applies. Integrated pages need neither an extension nor external connector. Explicit `select_browser({connectionId:"cardbush"})` followed by `new_page` is also supported.

Only explicitly referenced pages, pages created for the conversation, and verified local-child-created pages returned to it are authorized. Closed/replaced/restarted guests fail explicitly without selecting another page/browser. Remote workers do not control local integrated tabs. Advanced Chrome debugging must be switched back to normal Browser Use first. Integrated `download_file` tracking is unsupported and reports that limitation.

Before local child dispatch/resume/guidance, a private host channel verifies task ownership and transfers exact grants/routing. Model-provided parent IDs cannot grant access. Parent and child selection remain independent; repeated sync does not reset selection, while new explicit references propagate. Invalid references do not block nonbrowser work. Remote delegation never uses this grant channel.

Display ownership is separate: child tabs appear in the root conversation workspace without switching the user's active conversation or adding permissions. A successfully created child's guest is granted upward through verified ancestry, stopping at a parent bound to another window. Existing independent or later-referenced child pages are not propagated. Existing parent selection remains; an unbound parent can first read a returned page through CardBush, while a Chrome/Edge-bound parent must explicitly switch. Tool-close removes shared grants; stale manual-close/restart references fail.

The authenticated local MCP host routes page-level CDP to the owning webview or the paired external connector. Renderers can register only their own web guests, not app UI or other windows. Page selection and snapshot cursors survive individual HTTP calls. Local RPC bypasses plugin proxies; cancellation/timeouts release waits/debugging without replaying actions.

## Connection and recovery

- The product name is Browser Use and namespace is `browser_use`; internal `chrome` IDs/resources remain compatible and do not mean Chrome-only. Core `chrome`/`computer-use` aliases cannot be replaced by external packages. Installers reject collisions and scans ignore old conflicting user packages.
- Chrome/Edge load the same MV3 extension in their extension managers. First local connection requires one user confirmation in the CardBush-style extension UI, without a pairing code. The Agent cannot confirm it. Local App and CLI share the external-browser connection; CLI needs no App for Chrome/Edge, but integrated tabs require it.
- Reload an existing extension on upgrade rather than uninstalling its saved data. Build fingerprints compare disk popup and running service-worker code, including legacy workers without fingerprints. Reload preserves pairing, enablement and website grants. Stop the connector before reloading during control to avoid interrupting active input.
- Automatic recovery stops after three failures, with pause/count persisted across worker/browser restarts. Opening the popup does not reset it. `/browser retry` retries the host; Connect retries the extension. Request local connection again is an explicit new-target flow, retaining the old pairing until success. Rejection/cancel waits for another user action; retry does not silently revert to the old pairing.
- Codes are for explicit/manual or remote pairing; create at the target host and paste directly into its extension, never through the model. Each browser/profile has independent credentials; at most eight connections are retained. Five-minute code expiry governs initial pairing only. Temporary offline status does not require a fresh code.
- Fixed extension Origin and bidirectional HMAC protect loopback WebSocket, including browser identity. No token/code enters tool results or diagnostics. No external registry entry/MSIX capability is added. Diagnostics report handshake time/stage/reason, distinguishing no request from rejection.
- `list_browsers` reports names/types/online/default/session choice. `select_browser` explicitly binds a connection in protected routes.json. Default affects unbound sessions only. Offline/revoked connections never fall back to another browser; responses are scoped by request/session/connection, not tabId alone.
- Switching releases old control first, refuses in-flight operations and fails if release fails. New page/element IDs must be obtained afterwards. Removing a connection revokes only its credential and keeps bound sessions explicit. Connector off stops listening/control but retains routes/pairings; removing configuration clears them. Ordinary exit retains intent.
- While the extension worker lives, failures wait 1 then 2 seconds; one-shot 30-second alarms cover sleeping workers and clear on success/exhaustion. Browser scheduling can delay them. Explicit disconnect stays off. Temporary grants/group IDs are session-only; personal tabs are never reclaimed by name after restart.
- App is single-instance per profile. Tray relaunch restores the existing window. Bridge startup failure preserves intent/routes/pairings and exposes explicit retry/disable.
- Only bridge-confirmed `not_dispatched` requests may await reconnect, up to eight seconds and half the remaining budget, pinned to the original connection. Explicit switching cancels that wait. Sent or outcome-unknown actions are never replayed. Rotating logs record state changes, not page content/codes.
- Advanced Chrome DevTools MCP is an explicit Chrome-only option, never automatic fallback. CardBush connector/adapter/skill use repository Apache-2.0; upstream Google MCP/dependencies retain their own licenses and axe-core source notices in `assets/plugins/chrome/THIRD_PARTY_NOTICES.md`.

`open_external_url` opens and leaves a normal browser through private host `browser.open-external` / shell.openExternal, outside the terminal task tree. It accepts credential-free HTTP(S), not arbitrary executable protocols, and does not grant page control/pairing. `dispatched` proves only OS acceptance, not navigation success. Independent workers do not inherit this local desktop capability.

## Pointer actions and progressive snapshots

`pagePointer.ts` validates attached/visible/non-inert nodes and disabled ancestors. Zero-area controls require an explicitly associated visible label. Viewport content quads and CDP hit-testing handle descendants, Shadow DOM, iframe geometry/visibility and overlays. Recheck after hover and before a second double-click. Failure does not switch to JavaScript click, Enter or repeated physical input.

Receipts use `input_dispatched`, `hitTargetVerified:true`, `outcomeVerified:false`; business success still requires observation. Browser validation/input is not atomic. Partial failure reports attempted downs/completed clicks so uncertain submissions are not duplicated. Hit-test document coordinates are recomputed from viewport position and current scroll on every check, including zoom/iframe/hover-induced scrolling; diagnostics retain both points and offsets.

`take_snapshot` defaults to 60 lines and approximately 7,000 escaped characters, with body only in content and metadata/counts/omissions/nextCursor in structuredContent. rootUid/query/roles filter noise and duplicate InlineTextBox. `rootUid + fullText:true` pages raw AX text by field/character offset with stable cursor replay. Pagination is tied to the acquisition/session/browser; navigation/new snapshot invalidates it explicitly. Retained compact text is bounded to 512 KiB/4,000 lines each and 2 MiB/eight snapshots globally, with three-minute expiry or immediate connection-release cleanup. Omissions are explicit; filtering can continue. No full raw AX tree is retained. Initial AX acquisition is still real browser work; pagination reduces subsequent transmission/context.

## Browser UI and local data

Core catalog descriptions/default prompts localize through manifest defaults and cardbush.localizations, with default fallback and no configuration rewrite. Browser and Computer Use have separate settings pages. Core components do not import plugin-management UI/styles in reverse.

Tabs show favicons, readable titles, persistent close and overflow scrolling; + creates a fresh blank tab/address focus. Audible tabs show mute; muted tabs retain unmute without pausing media or changing webpage volume. Chromium events cover background/frame/Web Audio without polling. Favicon metadata is local; unvisited bookmarks may fetch the site's own favicon, never an external tracking favicon service.

Address parsing adds HTTPS to domains, HTTP for localhost/loopback, and uses Google search for other text. Empty text does not navigate; local paths/executable schemes do not go to search. OAuth popups preserve native window identity, named-window reuse, messages, cookie session, POST and self-close. Site applications use same-origin manifest start/identity/scope with bounded read, ownership revalidation and name/icon fallback; manifests cannot register tools/plugins or grant capabilities.

New pages use about:blank, not legacy homepage configuration. Explicit URLs remain explicit. Menus provide find/Ctrl+F, native print, zoom, responsive viewport, visible PNG, bookmark import/search, downloads/history/cleanup/settings on the actual active guest. Outside click, webpage input, Escape and blur close menus without stealing input; menu zoom stays open. UI supports both themes.

Bookmark import parses selected Chrome/Edge profiles or exported HTML/raw JSON, preserves folders and deduplicates normalized URLs, rejecting credentials/executable schemes. No passwords/cookies/contacts are imported. New tab shows 12 shortcuts plus searchable complete bookmarks in batches of 24; management pages use 50. History retains 5,000 URLs since feature introduction; downloads retain 1,000 records with pause/resume/cancel/reveal. Restart marks unfinished downloads interrupted. UI-only `browser/library.json` is not model context. Deleting history/download records does not delete downloaded files or active records.

Cleanup independently selects history, finished downloads, cache and current-origin site data. Validate guest/current origin again; changed navigation requires reselection. Do not clear app localStorage, bookmarks or chats. Import/manage IPC is main-window-only, with no desktop bridge in webpages.

Pages use 100% zoom by default with explicit 25%–500% and Chromium site persistence. Wide pages scroll horizontally rather than auto-shrinking text. Panel sizing coalesces updates; right-edge resize first changes a docked inspector while preserving chat width until its minimum. Native move/maximize/left-edge changes retain their own layout rules. Loading follows top-document navigation without re-hiding painted content for iframe lazy loading/anchors; late readiness clears timeout messages.

Embedded pages cannot launch native protocols through top pages, hidden frames, redirects or popups. Shared session permissions deny openExternal, keeping microphone restricted to the main app. Explicit toolbar external-browser opening remains available.

## Implementation ownership and limits

Browser UI lives in `src/features/browser`, bookmarks/start pages in inspector modules, import/library/current-guest actions in `electron/browserImport.ts`, `browserLibrary.ts`, `browserUi.ts`. Computer Use settings live in `src/features/computerUse`. CoreCapabilitySettings adapts existing apps.json configuration. Runtime routes through cardbush-chrome-mcp, chromeConnector and bundled extension; coreCapabilities/productPlugins protect identities. Legacy homepage read/write compatibility does not make new tabs use it. Browser/Computer Use remain fixed host services, not replaceable generic plugin implementations.

External extensions/passwords/autofill remain browser-native. Arbitrary Web Store extensions are not promised inside Electron's [extension API subset](https://www.electronjs.org/docs/latest/api/extensions). Unified external-link preferences, compact/full address preference, cross-restart download resume/default directory, origin-persistent embedded camera/mic settings, separate browse/upload/download grants, screenshot annotation preferences and WebMCP are not all implemented. Full CDP is distinct authorization; site access or plugin installation cannot enable it. Existing history stays private to local UI. See the [Session API](https://www.electronjs.org/docs/latest/api/session) for implementation primitives.

## Computer Use displays and evidence

Observe discovers display IDs, physical bounds/work areas/scales and each window's display. Optional display_id selects a single original screenshot; otherwise existing window discovery/whole-desktop behavior remains. Overview images are observation only; input requires a specific hwnd and single-use state_id.

Capture/input uses Per-Monitor V2 physical pixels without multiplying scale again; deliberate crop/resize maps through image.origin/scale. Runtime respects original-detail MCP metadata, stores immutable original snapshots separately and rejects oversize originals rather than silently reducing them. Provider-side vision preprocessing is outside this local guarantee.

Each observation binds display-layout signature and window DPI. Input checks again at tool/native boundaries, with additional window/DPI checks during long typing/dragging, without polling. Monitor connection/removal/position/scale/work-area changes require reobservation. PrintWindow failure/uniform output may fall back to verified visible capture only for a fully on-screen, foreground, unoccluded target, checked before/after and respecting capture exclusion. Uniform color alone is not failure; unverifiable evidence is marked false and blocks physical input. Windows Graphics Capture is not implemented; timeout protects a hung PrintWindow and some protected/GPU/occluded cases remain unsupported.

## Verification

- `test:browser-integrated`: real Runtime/webview grants, local child handback, nesting, independent selections, window/URL/guest isolation, screenshot/navigation/stale references and stuck-script cancellation.
- `test:desktop-browser`: URL/cancel/error and an isolated real browser surviving terminal/turn/Runtime cleanup.
- `test:chrome-actions`: hidden Electron/CDP hit-testing, zero-area controls, overlays/disabled/hover changes, Shadow DOM/iframes, partial input and snapshot budgets/cursors.
- `test:inspector-browser`: real Electron OAuth popup routing/cookies/POST/cleanup. Reaching a login page is not successful account authorization.
- `test:browser-ui`: isolated bookmark imports/history, find/zoom/viewport/screenshots/downloads/site cleanup/favicons/narrow themes. Printing checks routing without opening a real print dialog.
- `test:chrome-connector`, plugin-connections-ui `--core-settings`, and `test:application-instance`: pairing, identity, bounded recovery, route/lifecycle, retry/disable and single-instance behavior.
- apps-mcp automatic/native tests include physical multi-display movement/click counters and screenshot evidence; injected layout changes do not count as physical hotplug certification.
- `node scripts/test-browser-use-native.mjs`: production broker/extension in isolated hidden Chrome/Edge profiles, never user profiles. This is not Store/MSIX certification or every-third-party-extension compatibility.

Dated measurements and specific browser/display versions remain in the [original reports](CORE_BROWSER_COMPUTER_USE.en.md). They do not extend the scope of current tested platforms or claim account authorization.

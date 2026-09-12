# Window material

CardBush uses Windows' native Mica backdrop for the main window in its standard
light and dark themes. The default is enabled; **Settings → Personalization →
Window glass effect** switches between native material and an opaque surface
without recreating the window or reloading a conversation.

The title bar and navigation sidebar expose the same DWM backdrop with a small
neutral tint. The conversation and settings reading surfaces remain opaque.
No desktop screenshot, wallpaper copy, CSS distortion, or extra animation loop
is used to produce the effect. The existing wallpaper accent remains available
to other themes, but is not painted over Mica.

## Reference and implementation

Read-only inspection of the locally installed Codex Windows package
`26.908.4834.0` found that its main window selects `backgroundMaterial: 'mica'`
with `backgroundColor: '#00000000'`. Its macOS path uses `vibrancy: 'menu'`.
Its opaque mode removes the native material. CardBush uses Electron's public
Windows API independently; no Codex package or private native API is required.

This is a wallpaper-adaptive native material, rather than Apple's Liquid Glass
refraction effect. See [Microsoft's Mica specification](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)
and [Electron's background material API](https://www.electronjs.org/docs/latest/api/browser-window#winsetbackgroundmaterialmaterial-windows).

`electron/windowAppearance.ts` owns capability selection and native backing
colors. `src/features/appearance/windowAppearance.ts` only opens the document's
transparent layers after the host confirms an applicable material. Stale theme
replies are ignored; focus, visibility and page restoration preserve that state.
`src/styles/windowMaterial.css` styles only the confirmed native surface.

## Fallback and lifecycle

- Windows 11 22H2+ and an enabled GPU compositor are required for Mica.
- Other operating systems, reduced transparency, high contrast, or native API
  failure use the normal opaque theme. Windows also controls its own inactive
  window and power-saving fallback.
- Parchment, Cyberpunk, and imported custom themes retain their own backgrounds.
- Repeated focus/restore notifications do not reapply unchanged native material.
- When material is disabled, both the HWND and native content View receive the
  opaque theme color after material removal, preserving the existing protection
  against white backgrounds during restoration.
- Material failures never reload or recreate the application.

## Verification

Run `npm run test:window-material` for policy/failure tests and an isolated native
Electron window using the real appearance hook and shell components. It covers
transparent ancestors, opaque reading surfaces, theme switching, delayed replies,
system accessibility changes, and special/custom themes.

On Windows this also probes the native HWND hit-test after scrolling tool buttons,
switching to settings, and changing zoom. Empty title-bar regions must return
`HTCAPTION`, and its buttons must remain `HTCLIENT`. The native system menu must
retain Restore, Move, Size, Minimize, Maximize and Close. The fixture cancels menu
display and does not move the user's pointer or open a visible test window.

Drag exclusions are scoped to `.window-drag` controls. A global `button { app-region:
no-drag }` registers offscreen scrolling controls with Electron 42; their unclipped
rectangles can override the caption, disabling both drag and right-click system
menu access. The earlier spacer pseudo-element did not prevent this overlap and
has been removed. Native window behavior remains owned by Electron/Windows, as
described in [Electron's draggable region guide](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions).

Run `npm run preview:window-material` to open an independent interactive preview.
The title bar switches light/dark and glass/solid. It uses no product profile,
Runtime, model credentials, or real conversations. Closing it ends the preview.

On the development Windows 11 machine, a native DWM query confirmed backdrop
type `2` (main-window material) and dark mode enabled. A foreground desktop
capture confirmed wallpaper tint in the title bar/sidebar. Electron's content
capture and some window-capture paths omit DWM's backdrop and are unsuitable for
judging the glass effect from screenshots alone.

Both TypeScript configurations, native appearance tests, the mounted app-view
regression suite, and the application build passed. The sidebar interaction
contract now follows the shared resize width and column cursor. The existing
`test-renderer-resilience.mjs` has an unrelated stale assumption about an absent
navigation guard fixture, already present in the pre-change source.

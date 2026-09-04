# CardBush Theme Contract

## Sources of Truth

| Concern | File | Required change for a new theme |
|---|---|---|
| Public theme types | `src/types.ts` | Add the theme ID to `ThemeMode` and, if user-selectable, `ThemePreference` |
| Runtime catalog | `src/features/appearance/themeRuntime.ts` | Add the native-safe base color and compatibility class behavior |
| Preference and resolution | `src/App.tsx` | Accept stored values and resolve the preference to a concrete theme |
| Settings choice | `src/features/SettingsView.tsx` | Add a localized, understandable option |
| Theme tokens and component overrides | `src/styles/themes/<theme-id>.css` | Keep all optional-theme rules scoped and import the file from `src/main.tsx` |
| First paint | `index.html` | Resolve the saved choice before React and provide the correct splash/background colors |
| Native Electron windows | `electron/main.ts` | Add the theme to sanitizers and native window background maps |
| Renderer bridge types | `electron/preload.ts`, `src/types/electron.d.ts` | Keep theme unions aligned across the process boundary |
| Secondary renderers | `src/ShadowWindow.tsx`, `src/CardlingWindow.tsx` | Apply runtime theme classes and background colors |

Missing any one of these can produce a white flash, a rejected IPC value, or a secondary window that falls back to ordinary dark mode.

## Theme CSS Configuration

Start each theme file with a single token block:

```css
.app.theme-example,
.cardling-desktop.theme-example {
  color-scheme: dark;
  --bg: #000000;
  --surface: #080808;
  --surface-strong: #101010;
  --surface-raised: #181818;
  --border: #303030;
  --accent: #00d8ff;
  --accent-soft: #08242a;
  --text: #f5f5f5;
  --text-mid: #c4c4c4;
  --text-soft: #8c8c8c;
  --shadow: rgba(0, 0, 0, 0.5);
  --user-bubble: #121212;
  --terminal-bg: #020202;
  --danger: #ff4567;
  --wallpaper-accent-rgb: 0 216 255;
  --wallpaper-accent-hex: #00d8ff;
}
```

Keep these semantic meanings stable:

- `--bg`: application and native-window base.
- `--surface`, `--surface-strong`, `--surface-raised`: progressively elevated layers.
- `--border`: low-emphasis structure, not the main accent.
- `--accent`, `--accent-soft`: primary state and its quiet background.
- `--text`, `--text-mid`, `--text-soft`: three readable hierarchy levels.
- `--user-bubble`: user message base.
- `--terminal-bg`: code and terminal foundation.
- `--danger`: destructive/error state only.
- Wallpaper accent values: shell integration fallback.

Theme-specific tokens are allowed when the visual language genuinely needs a secondary accent, but prefix them with the theme name or a distinctive theme namespace.

## Selector Strategy

- Load the base `theme.css`, then `app.css`, then optional theme files. Later theme rules may specialize mature base components.
- If a specialized theme extends dark behavior, return both `theme-dark` and `theme-<id>` from `themeClassNames()`. Do not copy the entire dark stylesheet.
- Use low-specificity component selectors such as `.app.theme-example .composer-surface`.
- Avoid `!important` except for an existing platform invariant that cannot be expressed through cascade order.
- Do not style by generated DOM position or translated text.
- Keep pseudo-elements non-interactive with `pointer-events: none`.
- Never put `clip-path`, `overflow: hidden`, or a transform on a container that owns popovers until its overlay behavior has been verified.

## Performance and Accessibility Gates

- No remote CSS imports, remote image URLs, or web fonts in a built-in theme.
- No continuous scanline, glitch, glow, particle, or hue-rotation animations. A visual theme must not increase idle rendering work.
- Avoid large blurred shadows and full-window `backdrop-filter`. Prefer static gradients and opaque/mixed surfaces.
- State transitions should normally stay at or below the existing motion tokens and stop under `prefers-reduced-motion`.
- Keep keyboard focus visible and do not encode success, warning, or error only by color.
- Check normal and higher contrast preferences.
- Keep long Chinese and English labels readable at narrow widths.

## Cross-Surface Review Matrix

Review at minimum:

1. App launch before React mounts.
2. Empty and long main conversations.
3. Active, running, unread, pinned, and overflowing sidebar rows.
4. Composer focus, attachments, model picker, permission selector, and disabled send.
5. Browser/file/review tabs and their add menu.
6. Settings navigation, cards, radios, switches, inputs, and dialogs.
7. Diff additions/deletions, code blocks, terminal output, and tool execution states.
8. Embedded and separate Shadow conversations.
9. Cardling closed/open/error states.
10. Imported palette behavior, including fallback to its declared base theme.

Capture visual evidence when possible, then fix clipping, weak hierarchy, excessive glow, inconsistent corners, and accidental regressions before delivery.

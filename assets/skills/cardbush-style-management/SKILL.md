---
name: cardbush-style-management
description: Use when creating, changing, reviewing, or debugging CardBush desktop visual themes, global design tokens, component appearance, theme switching, startup colors, or cross-window style consistency. Trigger for CardBush UI restyling, new optional themes, palette/typography/shape changes, visual polish, and theme performance work. Do not use for styling unrelated websites or documents.
description_zh: 用于创建、修改、审查或调试 CardBush 应用主题、界面样式、配色、字体、组件外观、主题切换、启动颜色及多窗口视觉一致性；不用于无关网站或文档的样式设计。
license: Proprietary
---

# CardBush Style Management

Use this skill to keep visual changes coherent across the main app, settings, inspector tabs, Shadow conversations, Cardling, and native Electron surfaces.

## Start Here

Read [references/theme-contract.md](references/theme-contract.md) before adding a theme or changing global visual behavior. Treat `src/styles/themes/<theme-id>.css` as the theme-specific visual configuration and `src/features/appearance/themeRuntime.ts` as the renderer-side runtime catalog.

## Workflow

1. Inspect the current UI, the affected component markup, and the existing theme selectors before editing.
2. Define or adjust semantic tokens first. Prefer tokens over repeating literal colors across components.
3. Scope every theme-specific override under `.theme-<theme-id>`; never make a new optional theme silently alter other themes.
4. For a new theme, register every extension point listed in the theme contract. A CSS-only change is incomplete because startup and secondary windows can otherwise flash or fall back.
5. Preserve interaction geometry, focus states, text contrast, imported palette overrides, reduced-motion behavior, and existing responsive layouts.
6. Favor static gradients, borders, masks, and short state transitions. Do not add continuous decorative animations, large-area live blur, remote assets, or layout-triggering effects without measured evidence.
7. For a component change, verify the affected component and its shared states in the relevant themes. For a new theme or global token/runtime change, also verify the main chat, settings, composer, menus, right inspector, review view, Shadow, Cardling, startup splash, and imported-palette mode.
8. Run checks appropriate to the changed surface. Use the full verification below for a new theme or global behavior change; a local style edit needs the affected visual/interaction checks, without unrelated theme setup work.

## Quality Bar

- The theme must feel intentional at first glance but keep long conversations readable.
- Accent colors must communicate hierarchy; they must not color every surface equally.
- Shape language must be consistent across navigation, cards, tabs, popovers, and inputs.
- No copied third-party logo, font, image, or proprietary UI asset may enter the repository without explicit authorization.
- A theme is not complete if a child window, native background, or first paint still uses another theme.

## Verification

For a new theme or global visual change, run:

```powershell
npm run test:cyberpunk-theme
npm run test:panel-motion
npm run typecheck
npm run build
```

When working on a different theme, add or adapt a focused contract test rather than assuming the cyberpunk test covers it.

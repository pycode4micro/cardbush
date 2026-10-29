# App language packs and appearance states

[English](README.md) · [简体中文](README.zh-CN.md)

The App's own text comes from `locales/*.json`: navigation, settings, conversations, composer and queue, permissions, tool status, voice controls, image viewers, Office/3D preview shells and native file/application menus. Renderer and Electron consumers share `@cardbush/platform/i18n`; React imports it through `src/i18n`.

User-authored content, paths, protocol identifiers, file-type abbreviations, product names and raw third-party/tool receipts are data, not App translations. Plugin/server localization dictionaries use `localizedContent`. Model instructions and document contents are not UI copy. Translate an owned error message, but preserve machine-readable error codes.

## Adding a language

1. Copy `locales/en.json` to a new JSON file. Set its BCP 47 `locale` (for example `fr`) and native display `name` (`Français`). Translate `messages`, retaining message keys and placeholders.
2. Run `npm run test:ui-localization`. The platform build discovers JSON files, validates them and generates the shared catalog and typed message keys. No component imports, locale branches or selector edits are needed. The generated TypeScript file is ignored by Git.
3. Build/start the App normally. The settings language selector is populated from pack metadata. Persisted and system locales use the same resolver. For example, `fr-CA` can resolve to `fr`; an unsupported language falls back to English.

The builder and runtime support missing translations with English fallback. Shipped packs must be complete: the regression suite checks their keys against English. Add new messages to all shipped packs. Adding a pack requires a new App build; packs are not loaded from arbitrary runtime paths.

## Rendering messages

```tsx
const t = uiText(language);
return <button aria-label={t('image.preview', { name })}>{t('common.close')}</button>;
```

Use full sentences with named variables (`{name}`, `{count}`, `{duration}`), rather than joining translated fragments in code. Text, placeholders, tooltips and accessible labels all use message keys. Do not add `language === 'zh'` branches or bilingual objects in components.

Plural messages require `other` and may provide `zero`, `one`, `two`, `few` or `many`. Pass a finite numeric `count`; `Intl.PluralRules` chooses the form for the selected message's language. Every form must retain the message's required variables. `formatMessageList` formats lists using the language's conjunction rules. Dates and numbers use `Intl` with the selected language instead of translated locale constants.

Interpolation is plain, nonrecursive text. Use `{{` and `}}` for literal braces. Missing variables and unknown keys throw rather than silently producing an empty UI. React escapes text; plain HTML preview shells must use `htmlText` or equivalent escaping before inserting translations into HTML.

Pass the current language into components/helpers and hook dependencies. Components without a language prop use `useUiLanguage` under `UiLanguageProvider`. `uiText()` reads the document language when called, and defaults to English outside a document; use it for action-time errors, not module-level translated constants. The App publishes the selected language through the main-window-only `app:set-ui-language` channel; native dialogs and tray menus use it immediately, with the OS locale as the startup fallback. File/application actions can also carry an explicit language. Store keys for reusable label tables and resolve them during rendering so language changes update mounted controls.

## Appearance states

CSS owns visual variants. Use semantic classes or `data-*` attributes for state, and CSS custom properties for dimensions, palette, spacing and icon sizes. Do not select hardcoded colors, font/icon sizes, visibility or transforms with JSX ternaries.

Theme colors live in `src/styles/theme.css` and shared theme configuration. Queue dimensions (`--queue-row-height`, `--queue-control-size`, `--queue-thumbnail-size`, `--queue-prompt-font-size`) live in `runtime-rail.css`; gallery sizes and loading variants live in `message-image-gallery.css`. For example, a compact icon uses a CSS size variable rather than `size={compact ? 14 : 20}`.

Keep behavior, measured coordinates, dynamic canvas dimensions and imported document geometry in TypeScript. A conditional class or state attribute is appropriate: CSS, rather than the component, defines its visual effect.

## Verification

- `npm run test:ui-localization`: all shipped messages and placeholders, plurals, fallback, malformed inputs, isolated third-language discovery, shared ESM/CommonJS catalogs, and source guards across App/native UI.
- `npm run test:app-views`: conversation, welcome/first send, queue images, streaming, sidebar and previews.
- `node scripts/test-window-menu.mjs` and `node scripts/run-settings-context-ui-test.mjs`: native menus, language switching and responsive settings.
- `npm run build` and `npx tsc --noEmit -p tsconfig.json`: production and type checks.

Tests must use isolated temporary packs/configuration and must not modify the user's selected language or service connection.

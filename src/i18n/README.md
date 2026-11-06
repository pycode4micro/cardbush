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

## Web and document templates

The Web entry uses `web/Language.tsx` and the same language packs. Its selector is populated from `uiLanguages`; the selected locale updates mounted components and the document language. Persist only the language identifier, not translated text. Shared non-React helpers import `@cardbush/platform/i18n` and resolve messages when called.

Keep React form layout in a separate template component and inject typed values and callbacks. For example, `web/ModelAdmin.tsx` owns requests/state, `web/templates/ModelAdmin.template.tsx` owns layout, and `model-form.json` contains reusable field choices/defaults and message keys. Do not replace React with runtime HTML or JSX evaluation.

Static native HTML shells and their scripts live in `assets/templates/*.html` and `*.js.template`. The platform build compiles them into both ESM and CommonJS outputs; installed apps do not read the source tree or depend on the current working directory. Do not edit generated template modules. Use `renderHtmlTemplate` from `@cardbush/platform/templates`: `{{text:name}}` escapes plain values; `{{json:name}}` serializes a value as a safe JavaScript literal, including script-closing characters; `{{html:name}}` accepts an explicitly supplied, trusted renderer fragment via the third argument. Missing or unexpected variables fail, and substitutions are never evaluated recursively. Pass the selected language to previews, canvas exports and OAuth pages. Translations and user data remain text, including when they contain markup.

## Runtime status and model policies

Assistant reads accept the current UI language. Retain owned failures as message keys and variables until each read, so switching language also updates an existing error. Preserve provider errors as external data. Subagent fallback names use the shared locale resolver; explicit or persisted names remain unchanged. The CLI stays English and does not need a language selector.

MCP App shells, styles and bridge scripts also use `assets/templates` (`.html`, `.js.template`, `.css.template`). Inject translated host messages and safely serialized widget data. Keep iframe sandboxing, host-message validation and CSP enforcement in place; provider HTML remains untrusted sandbox content. Retired features must be removed with their private resources rather than migrated into new templates.

Model policies live separately in `assets/prompts/*.md`, exposed through `renderPromptTemplate` from `@cardbush/platform/prompts`. `{{value:name}}` inserts plain text without recursive interpretation. Do not route policy text through UI translations or change message roles/order during extraction. The builder normalizes line endings and removes the resource's final newline; leading and other trailing whitespace remain significant. Resources ship in ESM/CommonJS, without runtime filesystem reads. Update the intentional policy digest fixture when changing policy text, and retain the semantic policy tests.

## Appearance states

CSS owns visual variants. Use semantic classes or `data-*` attributes for state, and CSS custom properties for dimensions, palette, spacing and icon sizes. Do not select hardcoded colors, font/icon sizes, visibility or transforms with JSX ternaries.

Theme colors live in `src/styles/theme.css` and shared theme configuration. Queue dimensions (`--queue-row-height`, `--queue-control-size`, `--queue-thumbnail-size`, `--queue-prompt-font-size`) live in `runtime-rail.css`; gallery sizes and loading variants live in `message-image-gallery.css`. For example, a compact icon uses a CSS size variable rather than `size={compact ? 14 : 20}`.

Keep behavior, measured coordinates, dynamic canvas dimensions and imported document geometry in TypeScript. A conditional class or state attribute is appropriate: CSS, rather than the component, defines its visual effect.

## Verification

- `npm run test:ui-localization`: all shipped messages and placeholders, plurals, fallback, malformed inputs, isolated third-language discovery, shared ESM/CommonJS catalogs, and source guards across App/Web/native UI.
- `npm run test:web-admin-ui`: actual Web forms, live language switching, draft retention, submissions/retries, narrow windows and text escaping with isolated mock services.
- `npm run test:html-templates`: packaged templates, strict variables, text escaping and localized preview/OAuth output.
- `npm run test:nonweb-templates`: policy text preservation, ESM/CommonJS packaging and MCP input escaping. Run `node scripts/test-mcp-apps-ui.mjs` for actual sandbox communication.
- `npm run test:app-views`: conversation, welcome/first send, queue images, streaming, sidebar and previews.
- `node scripts/test-window-menu.mjs` and `node scripts/run-settings-context-ui-test.mjs`: native menus, language switching and responsive settings.
- `npm run build` and `npx tsc --noEmit -p tsconfig.json`: production and type checks.

Tests must use isolated temporary packs/configuration and must not modify the user's selected language or service connection.

# Network proxies

[English](PLUGIN_PROXY.en.md) · [简体中文](PLUGIN_PROXY.md)

[中文](PLUGIN_PROXY.en.md) | [Documentation](README.md)

Settings → Network proxy has two layers: **App default** for model generation/discovery, account login and cloud voice; **Marketplace and plugins** normally inherits it but may override marketplace downloads, plugin pages and plugin/MCP defaults. Per-plugin/per-MCP overrides take precedence. Both pages use one editor. Discrete options autosave; manual addresses apply only after validation/save, leaving current networking intact during edits.

Plugin proxy links open these unified settings. The marketplace page shows the default above searchable installed-plugin/standalone-MCP rows. System/app-default/direct choices autosave; manual values require Save or Apply to all. UI distinguishes saving, saved and unsaved state; filtering preserves row drafts.

| Mode | Behavior |
| --- | --- |
| Use default | Initial per-item state; follows changes to the page default without saving each row |
| Follow app default | Uses app routing even if plugin default differs |
| Direct | Clears inherited process proxy variables and sets `NO_PROXY=*` |
| System | Resolves per target URL, including PAC and bypass rules |
| Manual | Separate HTTP_PROXY, HTTPS_PROXY, NO_PROXY; HTTP/HTTPS/SOCKS4/SOCKS5/SOCKS5h addresses |

The plugin default initially follows the app; existing `model` configuration means this inheritance, retaining storage/preferences. Plugin detail and list entries edit the same settings. A plugin's MCP servers follow their owner rather than duplicating rows; standalone MCP has its own row.

Apply to all first validates/saves the top selection, including unsaved manual addresses, then clears every per-item override/draft. This includes filtered/disabled entries; future installs also inherit. It persists across navigation/restart while permitting later exceptions. Plugin and standalone MCP files remain separate; partial save failure shows errors and rereads actual disk state rather than claiming total success.

## Persistence and application

- Plugin default: `product-host/config/apps.json` → `proxy`; item override: `plugins[].config.proxy`. Missing old fields inherit.
- Standalone MCP: `product-host/config/mcp-servers.json` → `servers[].proxy`; removing it restores inheritance, without duplicate service storage.
- Host-resolved effective proxies enter internal MCP connection snapshots for change detection, not model-visible schemas. Credentials/local relay ports are not duplicated as persistent settings.
- Existing asynchronous connection scheduling applies saves, replacing only effectively changed connections and respecting active-Turn catalog publication boundaries. It does not refresh the whole UI.
- Background refresh preserves lists/editors. Late stale reads cannot overwrite newer saved revisions; unchanged observations reuse UI state.

## Coverage

HTTP/SSE MCP, stdio, HTTP auth-header helpers, direct OAuth, plugin Hooks and Agent-local MCP use their item's route. Marketplace/Git/npm/model downloads use plugin default. Shared OpenAI/SIWC login/token refresh uses app default; each authenticated app's MCP traffic uses its own override.

Embedded plugin scripts/styles/images/browser requests use plugin default. Responses/Chat/Messages, model discovery and cloud voice share the same host resolver. New requests follow saved routes; an already streaming request keeps its original one.

Embedded routes update on save and again before opening, clearing old proxy pools without app reload/direct fallback or third-party request/CSP rewriting. Embedded pages share the main window browser session, so per-plugin overrides currently affect MCP/processes while page resources use the common plugin default. App-default saves serialize; UI-route/MCP-refresh failure restores prior configuration and reports the error.

The host uses isolated Chromium resolver sessions. Node traffic and standard stdio proxy environments use an authenticated loopback HTTP relay with random credentials and identical routing rules. HTTP/CONNECT stream, cancellation closes upstream, and failures never silently go direct. Manual HTTP/HTTPS addresses apply only to their respective protocol; unspecified protocols go direct.

Initial HTTPS CONNECT authentication requires a complete 407 response with `Proxy-Authenticate`; the host login event then supplies relay credentials. A bare 407 causes Chromium `ERR_PROXY_AUTH_UNSUPPORTED`, leaving a page shell without scripts/styles.

This controls CardBush transport and plugin environment variables, not code that ignores those variables or already-running external browsers/Blender. No global machine proxy or parent-process environment is changed.

## Checks

`npm run test:plugin-proxy` covers inheritance/persistence, standalone MCP, parallel routes, bypass, raw output, credentials, SOCKS, cancellation, real isolated Electron PAC/Utility Process/stdio and unified-list filtering/drafts/save/retry/inheritance/narrow UI.

Tests use local services/isolated settings, not real accounts/models. HTTPS UI checks use a fresh browser session and test-only loopback certificate, verifying first CONNECT auth, scripts and fetch without cached HTTP authentication masking failures.

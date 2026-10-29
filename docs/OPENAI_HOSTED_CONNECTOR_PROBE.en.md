# OpenAI hosted connectors and independent probe

[English](OPENAI_HOSTED_CONNECTOR_PROBE.en.md) · [简体中文](OPENAI_HOSTED_CONNECTOR_PROBE.md)

This experimental integration uses CardBush plugin settings and the existing MCP client. CardBush logs in, stores and refreshes its own credentials. It does not start Codex or read Codex configuration, sessions or login files. The standalone probe shares OAuth/result validation code but retains credentials only in memory.

## Using the integration

1. Open Settings → Plugins → OpenAI account, select login and complete browser authorization.
2. Registered `.app.json` applications default to the OpenAI-hosted source. Connect the application, follow its OpenAI page, and complete provider OAuth using the same OpenAI account.
3. Returning to the plugin page checks the connection automatically; Check connection is also available. Only successful tool discovery marks it connected. Account settings retains login/logout, refresh-all and management in ChatGPT.
4. Existing CardBush permissions still apply; plugins expose tools for their registered application only, with approval by default.

Direct addresses, OAuth parameters, service bindings, per-tool permissions and diagnostics are in collapsed Advanced settings. Existing direct configurations remain effective until explicitly switched; layout changes do not migrate sources or grants. `list_plugin_connections` reports registered app IDs, selected/supported sources, authorization links, actual errors and pending application. A supported source, saved option or opened webpage is not proof of authorization or connectivity.

Authorization URLs follow the [public client's catalog rules](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/connectors/src/lib.rs#L482), use OpenAI HTTPS and contain no token. Provider OAuth belongs to OpenAI; CardBush receives neither Google's authorization code nor its tokens. User consent on that page is still required.

Desktop credentials use system safeStorage in a separate `userData/mcp-oauth.bin` record, never plugin files, `apps.json`, model context or public logs. Hosted connections share a single concurrent refresh. Logout removes credentials and disables old connections; account switching never sends new credentials to an old MCP session. Catalog replacement waits for active calls while old credentials are invalidated immediately.

Desktop token and MCP requests use Electron `net.fetch` with the default session's proxy configuration and browser cookies explicitly disabled. The Node probe uses its process network environment. A real 401 allows one refresh, then requires login. Reconnection never replays an old tool call. Cancellation/timeouts surface without refreshing the whole app.

Connection status distinguishes waiting for active calls/resources, connecting and reading tools. Read-only polling follows pending configuration. Discovery reads all pages and rejects partial catalogs on failure, timeout or repeated cursors. Tools are filtered by registered application before SDK validation. An exactly empty optional `outputSchema: {}` is treated as unspecified while retaining the original and normalization metadata; nonempty schemas receive full validation. This is generic protocol compatibility, not an application-name exception.

## Support boundary and source

The implementation references public source commit `9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a`: [OAuth server](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/login/src/server.rs), [client registration](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/login/src/auth/manager.rs), and [hosted MCP transport](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/codex-mcp/src/mcp/mod.rs).

The experiment reuses that public OAuth client ID and product identifiers, so login may display Codex. It needs no Codex installation, but is not an independent CardBush client registration or a promise of official third-party-host support, stable service acceptance, or access to every application.

## Running the probe

```powershell
node --use-env-proxy scripts/probe-openai-hosted-connectors.mjs --app-id connector_2128aebfecb84f64a069897515042a44 --tool-resource gmail.get_profile
```

Open the printed `authorizationUrl` and authorize personally. After callback the probe connects directly and discovers tools. It can call only the explicitly selected app's declared read-only tool with no required parameters; this example reads account profile, not mail. Output includes phases, counts, success and sanitized errors, never profile content, result bodies or tokens. Omit `--tool-resource` for catalog-only verification. The app must already be connected in the OpenAI account; the probe does not authorize third-party apps.

`--interactive` keeps the process in memory for at most 15 minutes. `retry` reloads the fixed validation module and repeats the same read-only check; `stop` exits. The selected app/tool cannot change on retry.

Random state and PKCE S256 protect a local IPv4 callback (1455, then 1457 if occupied, without killing another listener). Host, path, source, state and duplicate callbacks are validated; timeout is ten minutes and Ctrl+C cancels. Token exchange/MCP use fixed OpenAI HTTPS destinations without redirects. Codes/tokens remain in memory, including an unused, unsaved refresh token requested by `offline_access`. Process exit does not revoke OpenAI's authorization record. Local callback tests bypass external proxies.

## Verification

`node --test scripts/test-openai-hosted-probe.mjs` covers state/PKCE, callbacks, cancellation, timeout, port conflicts, tool identity/read-only requirements, malformed responses and error redaction. `npm run test:openai-hosted` adds isolated desktop integration coverage, without real account access.

SDK validation failure retains the complete original `rawResult` and a separate client parsing error. Do not wrap a raw result, turn `null` into `{}`, or repeat a side-effecting call merely to satisfy a declared schema. Catalog normalization is distinct from result rewriting.

The dated unauthenticated/Gmail/Canva experiments remain in the [original report](OPENAI_HOSTED_CONNECTOR_PROBE.en.md). Their narrow account/catalog successes do not establish all-tool acceptance. In particular, a historical result-wrapper workaround was later removed; that old success is not proof of current live acceptance. Mock desktop flows and live account checks must be reported separately.

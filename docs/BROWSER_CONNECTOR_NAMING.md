# Browser connector naming and compatibility

The connector serves Chrome and Edge. Shared implementation modules, types,
functions, renderer APIs and CSS use `BrowserConnector` / `browserConnector` /
`browser-connector`. Chrome-specific APIs and product names stay unchanged.

Compatibility boundaries retained deliberately:

- The plugin ID `chrome`, asset directory `assets/plugins/chrome`, workspace
  package `@cardbush/chrome-mcp`, native-host build paths and executable names are
  installation identities. Moving an unpacked extension's directory would break
  the browser's existing registration.
- `cardbush.chrome_connector.v1`, legacy IPC channels, environment variable names,
  extension ID/key, pairing format and storage keys remain stable. No credential
  or grant migration is required.
- The preload exposes the old Chrome-named methods as aliases of the Browser
  methods. The MCP package keeps `createCardbushChromeServer`,
  `requestChromeConnector` and `ChromeConnectorError` as export aliases.
- `chrome.*`, `chrome-extension://`, `chrome://extensions`, browser kind `chrome`,
  Chrome executable/registry paths and Google's `chrome-devtools-mcp` describe
  actual Chromium APIs or Chrome-specific integrations and must not be blindly
  replaced with `browser`.

Use `npm run test:browser-mcp`, `npm run test:browser-connector` and
`npm run test:browser-reconnect-native` for the shared implementation. Existing
`test:chrome-*` commands remain compatibility aliases. The native test starts
the actual desktop entry point with private profiles and never uses the user's
browser data, saved credentials or account settings.

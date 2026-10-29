# Dependency and Node maintenance

[English](DEPENDENCY_SECURITY.en.md) · [简体中文](DEPENDENCY_SECURITY.md)

[中文](DEPENDENCY_SECURITY.en.md) | [Documentation](README.md)

Development, CI and Agent Docker images use Node 24 LTS. `.nvmrc` selects the major version, root `engines` is `^24.0.0`, and Node types use series 24. A terminal using Node 25 must switch before `npm install`; repository configuration does not change the system Node installation.

The maintained dependency set includes Electron 42, MCP SDK 2, patched sharp and affected transitive dependencies in the lockfile. Although Electron is a `devDependency`, it is the shipped desktop runtime: `npm audit --omit=dev` alone is insufficient.

Recent npm versions restrict undeclared install scripts. The repository explicitly disables optional native acceleration builds for `cpu-features` and `ssh2`, consistent with desktop packaging exclusions; SSH uses Node crypto. The unused Squirrel `electron-winstaller` 7-Zip selection script is also disabled; Windows uses NSIS/MSIX. Do not allow every script merely to silence warnings. Review purpose/version when enabling a necessary script.

## Scoped overrides

Root `package.json` scopes these overrides to parents that have not yet adopted the fixes, rather than globally replacing same-named packages. Prefer removing an override after its upstream updates, then verify.

| Parent | Override | Runtime check |
| --- | --- | --- |
| `@electron/get` | `global-agent@4.1.3` | Remove an old logging chain; initialize the actual electron-builder downloader's proxy and verify a request reaches a local proxy. |
| `@file-viewer/core` | `dompurify@3.4.16` | Same-major security update preserving preview HTML sanitization. |
| `concurrently` | `shell-quote@1.11.0` | Concurrent launch, normal argument parsing and rejection of newline injection after comments. |
| `exceljs` | `uuid@11.1.1` | Preserve CommonJS; write/reread extension icon-set conditional formatting that actually uses UUID. |
| `pptxgenjs` | `image-size@2.0.4` | Published PptxGenJS code does not call this old dependency; still verify dimensions, embedded images and PPTX output. |

Cross-major overrides require real call-path checks, not just a lower audit count. `npm run test:dependency-upgrades` runs in Windows/Linux desktop CI and covers these paths and sharp SVG rendering.

## MCP OAuth

CardBush's credential provider enforces issuer binding in addition to SDK updates. Preconfigured client secrets require a trusted `expectedIssuer`; a newly discovered server URL cannot rebind an existing secret. Dynamically registered credentials retain their issuer, and missing issuer metadata requires login again. See [plugin compatibility](PLUGIN_COMPATIBILITY.en.md).

## Verification

```powershell
node --version
npm ci
npm audit
npm audit --omit=dev
npm run test:dependency-upgrades
npm run build
npx tsc --noEmit -p tsconfig.json
npm run test:mcp-integration
npm run test:document-plugins
```

Do not use `npm audit fix --force` for unverified breaking upgrades. Prefer same-major fixes; verify actual interfaces and behavior when major changes are necessary. Audits cover known npm advisories, not all product security.

References: [MCP issuer binding](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h), [shell-quote](https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv), [UUID](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq), [sharp](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w), [global-agent releases](https://github.com/gajus/global-agent/releases).

# Contributing to CardBush

[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md)

## Set up a checkout

Use Node.js **24** and npm **10 or later**. `.nvmrc`, the package engine range, CI and Agent containers use Node 24. Build native packages on their target OS.

```sh
git clone https://github.com/pycode4micro/cardbush.git
cd cardbush
npm ci
npm run runtime-tools:install
npm run dev
```

Electron downloads use the official source by default. Configure `ELECTRON_MIRROR` only when your network requires it; `npm run fix:electron` repairs an incomplete download. Some native or plugin-specific checks require extra target-platform dependencies. See [dependency maintenance](docs/DEPENDENCY_SECURITY.en.md) and [Windows compatibility](docs/WINDOWS_COMPATIBILITY.md).

For a headless Agent checkout, use `npm ci --ignore-scripts`, `npm run build:agent`, then `node dist-electron/agentServiceCli.mjs --data-dir /absolute/path/agent-data`. This starts Node, not Electron. Use an isolated data directory for development.

## Find the right layer

| Directory | Responsibility |
| --- | --- |
| `packages/bush-runtime` | Agent loop, tools, permissions, task scheduling and state |
| `packages/bush-product-agent` | Product instructions and turn construction |
| `packages/cardbush-product-host` | Shared host configuration and command contracts |
| `packages/bush-protocol` | Typed commands, events and IPC |
| `packages/bush-provider-openai` | Responses, Chat Completions and Anthropic Messages adapters |
| `packages/bush-mcp-client` | MCP transports and resources |
| `packages/cardbush-platform` | Host capabilities, executables, native paths and shared localization |
| `packages/bush-runtime-electron` | Shared typed Runtime transport and clients |
| `electron` | Desktop lifecycle, Node services and host adapters |
| `src` | React UI and local/remote backend adapters |
| `scripts`, `deploy`, `packaging` | Verification, deployment and release tooling |

Read the [architecture guide](docs/ARCHITECTURE.en.md) before introducing a second execution loop, configuration store or transcript projection. Reuse the existing ownership and cancellation paths.

## UI and documentation changes

The repository's [AGENTS.md](AGENTS.md) and [localization guide](src/i18n/README.md) define UI rules. App-owned text belongs in `src/i18n/locales/*.json`; use message keys and named interpolation, and update all shipped language packs. React uses `uiText` / `useUiLanguage`; native/shared code uses `@cardbush/platform/i18n`. Do not edit generated message files or put language switches in business logic.

Keep visual variants in semantic classes, data attributes, CSS variables and theme tokens. Geometry measurements and canvas coordinates belong in logic; conditional hardcoded colors and dimensions do not.

Update paired English and Chinese current guides in the same change. Keep commands, defaults, feature boundaries and warnings equivalent. Preserve original filenames and historical reports so existing links remain usable. Update the [documentation index](docs/README.md) when adding a guide. Legal notices, executable skill instructions and dated investigation records are not silently rewritten as current user guides.

## Validate the change

```sh
npm run build
npm run typecheck
npm run test:release
```

`test:release` expects built outputs. On headless Linux, desktop tests need an available display, for example `xvfb-run -a npm run test:release`. Run the relevant feature checks rather than assuming the release suite covers every optional integration:

| Change | Useful checks |
| --- | --- |
| UI language or styles | `npm run test:ui-localization`; relevant UI regressions |
| Cross-app UI | `npm run test:app-views`; renderer type checking and production build |
| CLI or deployment | `npm run test:agent-chat`, `npm run test:agent-deployment` |
| MCP interoperability | `npm run test:mcp-conformance` |
| Assistant or voice | `npm run test:assistant`, `npm run test:voice-realtime`, `npm run test:voice` as applicable |
| npm distribution | `npm run package:npm`, followed by `npm run verify:npm-package -- --tarball /absolute/path/package.tgz` |
| Documentation only | Check links, anchors, commands, language parity and `git diff --check`. |

Use isolated configurations, mock providers and disposable workspaces. Do not change the user's language preference, real conversation store, global installation or live service to make a test pass. State whether evidence comes from a mock, an installed artifact or a live provider; one does not prove the others.

## Submit a change

Keep changes focused. Describe the user-visible problem, resulting behavior, affected boundaries and relevant validation. Include reproduction steps for bugs and identify any unverified platform or provider behavior. Do not include credentials, signing certificates, raw private logs, generated installers or npm tarballs in Git.

Report vulnerabilities through [SECURITY.md](SECURITY.md). Normal feedback belongs in [Issues](https://github.com/pycode4micro/cardbush/issues); changes can be proposed through pull requests.

## Release channels

Desktop Store packages, signed EXE/AppImage releases and npm Agent packages are different artifacts. See [cross-platform releases](docs/CROSS_PLATFORM_RELEASE.md), [MSIX](docs/MSIX_STORE_RELEASE.md) and [npm packaging](docs/NPM_AGENT.en.md). A build, upload or documentation version bump is not proof of publication. Verify the public artifact and its checksum, and preserve third-party licenses.

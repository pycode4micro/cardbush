# CardBush Desktop

[简体中文](README.zh-CN.md)

CardBush is an Electron desktop Agent application with its production Agent
Runtime embedded in TypeScript. Normal chat, sessions, model access, tools,
permissions, Goal, Plan, Subagent, Team and persistence run inside CardBush over
typed Electron IPC; no BushServer HTTP process or localhost port is required.

## Status

The current development baseline is `1.0.0-dev`. Product functionality is under
integrated validation; installer and release-freeze decisions are still pending.

## Development

Requirements: Windows, Node.js `>=22.12.0`, and npm `>=10`.

```powershell
npm install
npm run dev
```

Build and open the desktop application:

```powershell
npm run gui
```

Repair a missing Electron binary if necessary:

```powershell
npm run fix:electron
```

## Runtime architecture

- `@cardbush/bush-runtime` owns the provider-independent Agent loop.
- `@cardbush/bush-protocol` owns typed commands, events and IPC contracts.
- `@cardbush/bush-provider-openai` owns OpenAI-compatible provider transport.
- the Electron Utility Process owns Runtime execution and durable state;
- the Electron main process owns native desktop capabilities and Product Host
  configuration;
- React consumes typed Runtime events and never infers terminal state from prose.

The separate BushServer repository is a reference implementation and migration
oracle. It is not a production dependency of CardBush.

## Optional MCP integrations

External integrations are installed through the generic MCP configuration. Each
tool must declare a complete `cardbush/action_manifest` so Runtime can apply normal
permission, receipt and execution-fact handling.

CardBush bundles one independent stdio MCP server, `cardbush_apps`. It hosts the
shipped app plugins such as `computer_use`; those plugins are not Built-in Runtime
Tools and do not execute through a private Product Host bridge. See
[`docs/host/CARDBUSH_APPS_MCP.md`](docs/host/CARDBUSH_APPS_MCP.md).

Bot products are deliberately independent. CardBush does not own Bot accounts,
credentials, login, configuration, lifecycle, logs, or management UI. A Bot
project may expose one MCP `deliver` tool and its own management HTML; CardBush
does not special-case its server ID or store its secrets. See
[`docs/host/CARDBUSH_APP_HOST.md`](docs/host/CARDBUSH_APP_HOST.md).

## Validation

```powershell
npm run test:all
```

Faster checks:

```powershell
npm run typecheck
npm run build
npm run test:runtime
```

## Data and security

Runtime state, logs and large caches belong under Electron's local `userData`
directory. Small user settings are stored by the desktop product layer. Provider
credentials cross only the typed provider-binding command and are not persisted
in model requests, event journals, checkpoints or renderer-visible payloads.

The renderer uses context isolation and no Node.js integration. Do not attach
credentials, `.env` files, raw logs or user conversation data to bug reports.

## Repository layout

```text
electron/   Electron main process, Utility Runtime host and native capabilities
packages/   Runtime, protocol, provider, MCP client and Product Host packages
src/        React UI and typed Runtime client integration
scripts/    Development helpers and contract/release checks
docs/       Runtime, product and integration contracts
```

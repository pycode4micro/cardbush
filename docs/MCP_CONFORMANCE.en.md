# Official MCP Conformance

[English](MCP_CONFORMANCE.en.md) · [简体中文](MCP_CONFORMANCE.md)

[中文](MCP_CONFORMANCE.en.md) | [Documentation](README.md)

CardBush runs the official client suite against production `McpClientManager`, `McpOAuthCoordinator` and Runtime registration. The 18 core scenarios are unchanged upstream fixtures; extended legacy coverage includes one explicitly recorded fixture correction. There is no substitute MCP client or changed scoring rule.

The dependency is pinned to `@modelcontextprotocol/conformance@0.1.16`, [upstream source](https://github.com/modelcontextprotocol/conformance/tree/v0.1.16), commit `21a9a2febd7100d7c17ac1021ee7f2ed9f66a1e0`. The runner rejects unreviewed versions; review scenarios on upgrades.

## Running

```sh
# Build Runtime and run 18 unmodified core scenarios
npm run test:mcp-conformance
# Core + two legacy scenarios, with recorded issuer fixture correction
npm run test:mcp-conformance:all
# Exact upstream comparison: the 0.1.16 legacy issuer scenario still fails
npm run test:mcp-conformance:all -- --fixture-mode upstream
# One scenario, or legacy coverage only
npm run test:mcp-conformance -- --scenario auth/scope-step-up
npm run test:mcp-conformance -- --suite backcompat
# Skip rebuilding when already built
node scripts/run-mcp-conformance.mjs --output tmp/mcp-conformance/my-run
```

Output must be a new directory to avoid mixing results. Default: ignored `tmp/mcp-conformance/<timestamp>/`, containing `report.json`, official per-scenario checks, client output and logs. Reports include source/build hashes, suite/Node/platform, `fixtureMode`, `fixtureCorrections` and patch-load state.

Default core matches upstream `coreScenariosList`. `all` means the 20 integrated core/legacy scenarios, excluding three draft and three extension scenarios, explicitly recorded as excluded rather than passed.

Only temporary loopback services and isolated in-memory credentials are used, without user accounts, browser pairing/model settings or model calls. The driver simulates user consent on the official local fixture page; actual product callback/state/issuer/token validation still runs.

## Scoring and CI

- Pass requires successful official process exit, successful checks, no failures/warnings and confirmed driver completion. Early exit/timeout is failure.
- `scope-retry-limit` intentionally rejects tokens; the driver also requires final `auth_required`, not arbitrary crashes.
- Scenarios run serially to reduce reconnect timing interference, with client/scenario/outer timeouts.
- Windows/Linux desktop CI runs all 20 after builds and uploads reports. Legacy issuer uses the documented correction, without hidden baselines or expected-failure exemptions; any failure exits nonzero.

## Legacy issuer fixture correction

`auth/2025-03-26-oauth-metadata-backcompat` serves metadata at root `/.well-known/oauth-authorization-server` while declaring an `/oauth` issuer. The SDK expects the root issuer and raises `IssuerMismatchError`; direct official-SDK reproduction fails without CardBush too.

See upstream [march-spec-backcompat.ts](https://github.com/modelcontextprotocol/conformance/blob/v0.1.16/src/scenarios/client/auth/march-spec-backcompat.ts), [createAuthServer.ts](https://github.com/modelcontextprotocol/conformance/blob/v0.1.16/src/scenarios/client/auth/helpers/createAuthServer.ts) and [RFC 8414 §3.3](https://www.rfc-editor.org/rfc/rfc8414#section-3.3).

The source patch [0.1.16-legacy-issuer.patch](../patches/mcp-conformance/0.1.16-legacy-issuer.patch) separates issuer path from route prefix: the legacy case uses a root issuer while keeping `/oauth/authorize`, `/oauth/token`, `/oauth/register`. Other defaults stay unchanged.

Because the npm package ships minified code, a Node loader applies the equivalent correction only in that scenario process. Exact version/SHA-256 matching rejects changed or double-patched files. Original module URLs/resolution remain; `node_modules` is unchanged and the hook never enters product/client processes. `--fixture-mode upstream` runs originals. Corrected results are explicitly labeled, never represented as unmodified upstream success.

`oauthIssuer.test.mjs` confirms wrong issuer paths still fail before registration/consent. Product issuer/state/PKCE checks stay enabled. The unmodified case still failing confirms no relaxed product check. The local patch has not been submitted upstream; review/remove it when a future suite fixes the fixture.

## Historical run and coverage

The [original October 26 record](MCP_CONFORMANCE.md#2026-10-26-实测) retains Windows/Node v24.20.0/SDK2.3.1 evidence: 15/18 core before fixes, 18/18 after; original legacy 1/2 versus corrected 2/2. Product fixes preserve OAuth challenges/scopes across background discovery and interactive login, merge step-up scopes and request fresh consent, and apply elicitation defaults only to omitted accepted fields (retaining false/zero/empty values, none on reject/cancel).

It also retains exact regression counts, skipped-platform explanation and ignored evidence paths, including `issuer-corrected-all/report.json`, `issuer-upstream-confirmed/report.json` and `sdk-issuer-probe.log`. Historical Windows execution does not imply a completed Linux run merely because CI is configured.

This is a protocol gate for initialization, tools, elicitation defaults, SSE recovery, OAuth discovery/scopes/token authentication/preregistration. It does not establish model success rates or cover CardBush browser WebSocket pairing, system consent UI, MSIX startup, compaction, multi-Agent concurrency or the MCP server role. Draft/extension scenarios remain unintegrated; other modern behavior has separate product regressions.

# ChatGPT plan access (SIWC)

CardBush supports the official Sign in with ChatGPT flow for desktop and local CLI Agent models. In **Settings → Models → Add model**, choose **ChatGPT · SIWC**, select **Continue with ChatGPT**, grant plan access in the system browser, then choose a model from that account’s catalog. The account center also supports adding accounts, signing in again, opening usage settings and signing out.

This integration is separate from the existing OpenAI connector/MCP account. A connector login does not grant inference access. API-key model configurations continue to use their existing adapters and credentials.

## Ownership and data flow

- `bush-protocol/siwc.ts` defines the public account snapshot and `{ kind: 'chatgpt', accountId }` model reference. Model configuration, renderer storage, Runtime events and checkpoints carry no OAuth tokens.
- `electron/siwcOAuth.mts` owns the loopback authorization transaction, PKCE, state/nonce validation, dynamic client registration, signed OIDC identity verification, token exchange and revocation. OAuth endpoints are pinned to OpenAI; discovery supplies validated JWKS and revocation endpoints. The loopback listener binds only `127.0.0.1` and expires after ten minutes.
- `electron/siwcAccounts.mts` owns registrations in the existing encrypted desktop credential vault, under an independent key. A host ID survives sign-out. An issued client ID is retained even if the initial exchange fails. Identity uses the client registration and verified subject, never an email match. Repeated registration of the same identity preserves the account ID already used by model configurations.
- Refreshes serialize per account. Replacement tokens are persisted atomically before use. Cancellation of one requesting turn does not cancel a refresh shared with other turns. Sign-out immediately blocks new access, invalidates that account’s running provider streams, waits for any token rotation, revokes the latest renewable session and removes local tokens. Failure to confirm remote revocation is explicitly reported.
- `ProductModelConfigStore` and the Product Host resolve the same immutable binding for ordinary conversations, fixed/inherited child models, Shadow and automations. The private desktop/worker bridge obtains a fresh access token for each HTTP exchange. Refreshing a token does not change the binding revision or model-context prefix.
- `electron/localModelAccess.mts` connects the local CLI to that same desktop `SiwcAccounts` instance. The App owns the vault, registration and serialized token refresh; the CLI only requests short-lived access tokens over authenticated local IPC. Windows uses a named pipe and directory restricted to the current user and SYSTEM; Unix uses a private directory and socket. The descriptor contains a rotated IPC secret, never OAuth tokens. The broker exposes only account access, with cancellation and account-invalidation events, and has no HTTP endpoint.
- A ChatGPT model remains bound to the selected account. Missing permission, expiry, sign-out or quota exhaustion never silently switches to a different account or an API-key model.

## Local CLI

After signing in and choosing a ChatGPT model in the App, keep the App running and start `cardbush` in a working directory. The CLI reads the same model configuration and automatically requests authorization from the desktop; no service token, copied OAuth token or second account registration is needed. `/model` selects among the shared configured models. `CARDBUSH_CLI_PROFILE_DIR` can select a custom desktop profile.

The CLI still executes its own local sessions and tools. API-key models do not need the App running. For ChatGPT account models, closing the App or signing out invalidates active CLI account requests. A restarted App rotates the private IPC secret; the next request reconnects automatically. If the App is unavailable, the CLI stops with an actionable error instead of retrying or describing itself as a remote Agent. Upgrading this bridge requires restarting both the App and CLI.

## Responses compatibility

The existing Responses adapter continues to decode streaming output, reasoning, usage, local tool calls and replay data. Its SIWC projection:

- Uses only `https://api.openai.com/v1/responses`, `stream: true`, `store: false` and full history for each request.
- Sends system instructions as developer messages and supplies function declarations through `additional_tools` input items. Local MCP discovery remains a function call; native `tool_search` is not requested.
- Omits `previous_response_id`, `max_output_tokens`, `temperature` and `top_p`. Other unsupported hosted tools and request parameters are not emitted by this adapter.
- Uses local input-token estimation and the existing request-body budget; it does not probe the unsupported token-count route.
- Keeps normal API-key Responses, Chat Completions and Messages behavior unchanged. Authentication and quota failures do not trigger a protocol fallback.
- Preserves encrypted reasoning across stateless tool rounds. Quota exhaustion stops automatic retries; temporary usage-service failures use the existing bounded retry policy. HTTP and mid-stream failures retain their provider error codes and request IDs.

Model discovery calls the public `/v1/models` endpoint with the selected account’s access token, preserves the returned ordering, displays `display_name`, and sends the actual `slug`. Only catalog entries with `visibility: list` are offered. Switching accounts discards stale catalog responses. A returned catalog does not establish inference entitlement; successful inference is the confirmation.

## Current boundary

SIWC registrations and refresh tokens stay in the local desktop vault. They are not copied to the CLI, remote Agent services or obtained from Codex/ChatGPT credential files. Account access is granted only to the explicitly constructed local CLI host, never by inherited environment flags. A remote Agent requires its own supported credentials; resolving a local SIWC account there produces an explicit error. The remote model editor does not offer local ChatGPT sign-in.

An eligible ChatGPT account must complete the official browser authorization before real plan-backed requests can be verified. Automated tests use isolated accounts, signed JWT fixtures, real loopback callbacks and mocked OpenAI HTTP responses; they do not establish production entitlement or consume a user’s plan.

## Validation

After `npm run build:agent` (includes the native IPC permissions helper and desktop TypeScript build):

```sh
node --test --test-timeout=45000 scripts/test-local-model-access.mjs scripts/test-siwc-accounts.mjs scripts/test-siwc-model-host.mjs packages/bush-provider-openai/test/siwc.test.mjs
node scripts/run-siwc-ui-test.mjs
```

Coverage includes account/client isolation, state and nonce rejection, verified identity mismatch, duplicate registrations, rotating tokens shared by GUI and CLI callers, cancellation while persisting, sign-out during refresh, revocation failure, desktop reconnect, remote-service isolation, stale model discovery, model persistence, child/automation bindings, tool-call replay and cache-prefix stability. Isolated CLI processes exercise real model binding, authorization IPC, local file tools and final delivery against mocked provider HTTP responses. Existing connector-account, Responses, registry, tool-search and model-store regression tests remain applicable.

Official protocol references, checked 2026-10-02:

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

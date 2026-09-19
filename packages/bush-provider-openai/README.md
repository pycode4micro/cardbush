# Responses adapter compatibility

The adapter shares a compatibility profile through `ProviderCapabilityStore`, scoped to the endpoint configuration, credentials and model. A provider failure selects the whole profile without interpreting vendor error codes, parameter paths or message wording. The profile is a recovery policy, not evidence that every extension is individually unsupported.

The compatible projection uses ordinary `mcp_search` / `mcp_call` function tools, sends full history with `store: false`, uses local input estimates, and sends tool images as attributed observations after their complete function-result batch. Progressive tool discovery, instructions, reasoning and tool results remain available. This remains a Responses API adapter; it does not switch API families or model settings.

Any failure from generation may retry once with this projection, provided no text, reasoning, tool call or usage has been exposed. An early SSE error can recover just like an HTTP error. Once output is exposed, the failure is returned and the shared profile applies to subsequent requests. Requests already using compatibility do not get another compatibility retry. Cancellation and local validation/size failures never select the profile.

An exact-count failure records the original error and returns no exact measurement, allowing Runtime to estimate locally and generate directly in compatibility mode. Authentication, rate-limit and service failures use the same policy: if compatible generation also fails, its failure remains visible.

`provider_compatibility` Runtime journal events retain the original code, message, HTTP status and provider request ID, plus whether recovery retried, succeeded, failed, or was deferred. Diagnostic text redacts configured credentials. Console diagnostics carry request/session identifiers as well.

Profiles follow the capability-store expiry (7 days by default). Within that period, new conversations and app restarts reuse the endpoint-configuration/model profile immediately without another failed probe. Reusing a profile does not extend its expiry; new conversations after expiry evaluate the provider again. A successful compatible response also records the mode in its validated provider replay, so that existing conversation stays compatible after expiry/restart. Native historical calls are translated only in the outbound projection; persisted conversation data is never rewritten. The initial transition may invalidate a cache prefix once, after which the compatible history stays stable. Other models/endpoints retain their own profiles; changing endpoint configuration or credentials selects a separate profile.

Validation: `node --test packages/bush-provider-openai/test/*.test.mjs` after `npm run build:runtime`. `providerCompatibility.test.mjs` covers arbitrary HTTP errors, early/late SSE failures, shared/persisted profiles, native history and images, cache stability, cancellation, and durable Runtime diagnostics.

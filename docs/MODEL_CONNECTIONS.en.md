# Model connections and request headers

[English](MODEL_CONNECTIONS.en.md) · [简体中文](MODEL_CONNECTIONS.md)

[中文](MODEL_CONNECTIONS.en.md) | [Documentation](README.md)

Open App center → Settings → Models to add/edit a connection. The list shows name, protocol, reasoning, address and credential status; editing uses a separate dialog. Provider grouping and protocol selection are independent. Presets initialize empty connections; the app neither guesses protocols from model names nor switches protocol after request failure.

## Authentication

- **API Key:** supply the provider's key, API base and actual model ID. Protocols, gateways and custom headers below apply to this route.
- **ChatGPT · SIWC:** select this method in the local model editor, choose Continue with ChatGPT, complete browser authorization and select a returned account model. No API key is entered. OpenAI authentication for plugins/MCP is not inference authorization.

SIWC names/IDs come from the selected account, not a fixed guaranteed list. Visibility does not prove inference permission. Account settings allow login, usage settings and logout; quota/auth errors never silently switch accounts or API keys. SIWC shares the Responses adapter/Agent loop, using streaming and `store: false`. OAuth credentials remain in local encrypted storage, outside model config/history and remote config sync. Remote Agents need their own supported credentials. See [SIWC integration](SIWC_INTEGRATION.md).

Collapsed standard/compact composers show only the model name; opening the selector reveals provider, protocol and reasoning controls. Assistant selection is independent of ordinary chats and uses the same selection for display/request, falling back to the current default when unset. Inherited fork children follow their parent's current model/options at dispatch and continuation while preserving child history. Explicit clean configurations and remote execution hosts retain their own settings. Voice settings choose the call model separately.

## Per-model reasoning

Reasoning is saved by configuration ID, not shared by same-named models/providers/connections. Settings and composer update the same configuration across model switches/new chats/restarts. The old global setting is neither fallback nor copied to every model.

Unset means Provider default and omits an override; this differs from Off. Selecting Default clears the override. Failed saves preserve prior values and show errors. Quick updates modify only the selected model, not default selection, keys or other models.

Local/cloud configuration sync carries this field. Queued cloud requests retain the explicit send-time choice, including explicit provider default; API callers without a choice read the target config. Children switching models use the new model's setting unless explicitly overridden, while inherited children retain parent options. Background memory and schedules use their chosen model configuration.

| Protocol | Example base URL | Request suffix | Default authentication |
| --- | --- | --- | --- |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` | Bearer authorization |
| OpenAI Chat Completions | `https://api.openai.com/v1` | `/chat/completions` | Bearer authorization |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` | `x-api-key`, `anthropic-version: 2023-06-01` |

Enter a gateway's base including required `/v1` or other prefix, without adding an endpoint suffix. Existing unspecified protocols remain Responses. Blank API keys while editing preserve stored keys. Model discovery requires a key in the current dialog and uses selected-protocol auth/custom headers.

## OpenCode Go

For example, select Responses, base `https://opencode.ai/zen/go/v1`, and an actually supported model ID. Requests to `opencode.ai` automatically include:

- `User-Agent: CardBush/1.0`, overridable in advanced options.
- `x-opencode-session` from the executing Runtime session. Follow-ups, tools, maintenance and retries share it; different sessions remain distinct. A static custom header cannot override the real session ID.

Headers are generated per SDK request, not stored as mutable client session state or inserted into model input. Counting follows the same rule. Discovery is separate metadata traffic identified by `cardbush-model-discovery`. See [OpenCode Go requirements](https://opencode.ai/docs/go/).

## OpenRouter

The `openrouter` preset initializes an empty new connection with `https://openrouter.ai/api/v1` and Chat Completions. Enter an OpenRouter key and select a full `provider/model-id`; Responses/Messages remain explicit alternatives. Changing provider grouping never overwrites an existing base/protocol or entered custom address.

Only actual hostname `openrouter.ai` gets automatic headers:

- `x-session-id`: real execution session, at most 256 characters. Continuation/retries retain it; new/child sessions use their own. Static custom headers cannot merge sessions.
- `X-OpenRouter-Title: CardBush`, overridable with the same header or compatible `X-Title`. `HTTP-Referer` is not automatically set; configure attribution explicitly if needed.
- Bearer auth for all three protocols, including Messages instead of Anthropic's official `x-api-key` scheme. Model discovery uses Bearer and its independent discovery identity.

Chat maps low/medium/high to `reasoning.effort`; unset leaves provider defaults. The output limit includes reasoning and visible output. Streaming `reasoning`, compatible `reasoning_content` and `reasoning_details` are supported. Visible duplicates display once; encrypted/signature data is continuation-only. Details are retained in stream order and replayed with tool results only while model, connection revision and messages remain unchanged. Model/binding/message changes invalidate old sidecars. Truncation/interruption/errors never confirm incomplete calls.

Session headers support routing/cache affinity but do not make the server retain conversation history. Chat/Messages still send full retained history. Local fingerprints represent actual parameters/messages; provider usage is the evidence for cache hits. References: [quick start](https://openrouter.ai/docs/quickstart), [session/cache guidance](https://openrouter.ai/docs/guides/best-practices/prompt-caching), [reasoning replay](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), [Messages auth](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message).

The original guide retains September 29 regression/discovery observations. Those used public discovery and offline request tests, not paid inference across every OpenRouter model/account/route.

## Advanced options

Set context size, maximum output tokens and JSON custom headers. Defaults are **530,000 context tokens** and **128,000 output tokens**, including reasoning. Ordinary sessions, assistant, children, Team, Hooks, memory, model compaction and voice task summaries share defaults and inherit explicit selected-model budgets. Output must be smaller than context; configure actual limits for smaller models. SIWC omits unsupported output parameters and lets its service determine the limit.

Ordinary Agent sessions first derive handoffs from recorded tool names, reasons, receipts and final replies, without requiring another model summary after every Turn. Necessary failures, unfinished states and source references remain. If safe reduction cannot meet capacity, normal model compaction is the fallback, retaining the model, reasoning and output budget across retries/recovery. Triggers reserve output and safety margin. The model-summary 6,000-character field limit is not an output-token limit. Original records remain; temporary maintenance instructions do not enter later normal conversation. Assistant/realtime voice have their own maintenance paths; see [Context and memory](CONTEXT_AND_MEMORY.md).

Example custom headers:

```json
{
  "x-project": "example",
  "x-session-id": "{{sessionId}}"
}
```

`{{sessionId}}` expands at send time. Names are case-insensitive; duplicates, newlines and transport overrides such as `Host`/`Content-Length` are forbidden. Blank/`{}` clears headers. Header credentials belong to connection config, not conversation Provider-binding references or input fingerprints. Explicit config sync sends them with model keys to the authorized Agent.

Messages requires `max_tokens` and uses the shared default when unset. Its thinking mode defaults to adaptive: selected effort becomes `thinking.type=adaptive` plus `output_config.effort`. Older models may use a token budget, at least 1024 and strictly below output limit. Unset effort omits overrides; Off/`none` explicitly sends `thinking.type=disabled`. Actual supported levels depend on the model; see [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking).

Current Chat integration exposes low/medium/high. Historical `xhigh`/`max` map to high and `none` to the lowest available low; unset still omits the override. Protocol edits preview mappings and save supported levels. These are product choices, not a claim that every Chat model supports only three levels. Responses/Messages retain their own ranges.

The model picker labels protocol, with a full tooltip. Controls follow the selected connection: reasoning effort for Responses/Chat, thinking effort for adaptive Messages, or thinking budget. The selected page appears automatically; three-level mode leaves no unused expansion placeholder. Welcome, main and child conversations share the component.

Messages sends `cache_control: { type: "ephemeral" }` by default. Only an explicit parameter-validation rejection of that field permits one retry before output without it, recording lack of support by connection/model. Auth, capacity, other validation and interrupted streams do not trigger this fallback. Local CacheChain records do not prove provider cache hits.

## Responses counting and generation

Counting and generation have separate capability records scoped to connection/model. A 404/405/501 from `/responses/input_tokens` marks only `input_token_count` unsupported and falls back to local estimation, leaving native tools, result images and `previous_response_id` unchanged. Records expire after seven days, survive restart, and reads do not extend expiry. Auth/rate-limit/transient/validation errors do not record unsupported counting.

Generation applies an in-Responses compatibility projection only when a service explicitly rejects a capability actually present: native discovery, continuation, storage or tool-result images. At most one retry before output is permitted. Already displayed text/calls prevent replay. 401/403, 429, temporary service faults and ordinary parameter errors do not change format. 501/505 indicate unsupported functionality/protocol, not transient retry; other transient failures use Runtime's frozen-request retries.

Generation uses its own `responses_generation_compatibility` record, without migrating old broad fallback flags or adding old-session branches. Once projection is actually used, the session retains it even after capability expiry to avoid prefix rewrites. It does not disable working counts, which use the same projected input.

Offline tests compare actual generation requests before/after counting failures, including scope, restart, expiry, diagnostics and retry counts. They establish local architecture behavior, not live cache-hit rates.

## Runtime and validation boundaries

All protocols share one Agent loop. `ModelProviderRegistry` selects an adapter; Runtime builds `ModelRequest`, consumes `ModelEvent`, and `executeModelRound`/`InMemoryRuntimeHost` own tools, permissions, stop, retry, maintenance and persistence. Adapters translate requests/events without another conversation state, invoking tools or starting rounds.

Connection config, images, named instructions, tool-name mapping and discovery receipts are independent of Responses. Adapters map roles/content into unified text, reasoning, calls, usage and completion/failure. Signed thinking and native Responses replay stay opaque to Runtime.

Tool calls/results/images use legal protocol structures. Chat result images follow the whole tool-result batch. Messages combines results into user blocks and replays signed thinking only with unchanged model/binding and complete messages. Only fixed pre-conversation system/developer instructions go into Messages top-level system; mid-conversation Runtime instructions retain order in source-marked user content. Canonical roles stay intact. Block-level fingerprints avoid reporting a whole-prefix rewrite when appending maintenance to one user-content array.

Messages input-limit errors and `model_context_window_exceeded` become shared context-recovery signals. Runtime performs bounded maintenance when possible, otherwise fails explicitly instead of treating truncated prose as success. Abandoned stream text is cleared and unconfirmed calls are not executed.

Connections bind by revision; protocol/key/header edits create a new revision while active rounds retain theirs. Interrupted streams, missing end markers or incomplete call identities are not success. Truncated output does not execute unconfirmed tool batches. Complete transport with invalid JSON/schema produces ordinary tool errors and continuation. Messages projects historical calls that cannot be represented as objects, and their paired errors, into text rather than fabricating arguments.

Chat/Messages use complete retained history and local estimates, not Responses continuation IDs/exact-count endpoints. Responses native discovery/compatibility remain. Local/standalone Agents share model configuration and Provider factory; updating remote configuration alone cannot add adapters to an old runtime.

Offline checks use fictitious keys/local services for paths/headers, concurrent sessions, retries, fragmented SSE, tool round trips, signed thinking, images, cancellation/errors/byte budgets, real Agent Worker integration and the model dialog. They do not establish live access/quota for every account/model. Dated September 29 test counts remain in the original guide as historical evidence.

References: [Chat stream events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events), [Messages API](https://platform.claude.com/docs/en/api/messages/create), [Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).

`provider_stream_diagnostic` records request configuration metadata, block boundaries, stop reason/usage and progress/wait every 30 seconds, without content/keys or changes to prefix/retry policy. Stop reasons are recorded at `message_delta` to distinguish output limits from missing `message_stop`. The original [September 29 replay report](MESSAGES_STREAM_REPLAY_2026-09-29.md) retains two real frozen-request DeepSeek observations.

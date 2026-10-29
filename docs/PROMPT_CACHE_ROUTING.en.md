# Session cache routing and image diagnostics

[English](PROMPT_CACHE_ROUTING.en.md) · [简体中文](PROMPT_CACHE_ROUTING.md)

[中文](PROMPT_CACHE_ROUTING.en.md) | [Documentation](README.md)

## Supported routing

Responses/Chat adapters send `prompt_cache_key` only to confirmed HTTPS endpoints: OpenAI `api.openai.com` and native Ark `ark.<region>.volces.com`, including Beijing. A namespaced SHA-256 of the session ID creates a stable key without raw session IDs, keys, request IDs or time. Follow-ups, tool continuations, retries, maintenance and restart retain it; sessions remain separate. It is a routing hint, not another context/cache copy.

Unknown gateways, OpenCode, OpenRouter and ChatGPT account routes do not receive it automatically. Messages uses its own caching protocol. OpenAI compatibility does not imply every optional parameter is accepted; expand support only after checking the provider contract and request tests.

This does not enable Ark explicit caching or alter `store`, continuation, image processing, history or the shared loop. Counting omits the routing field; token budgets/calibration exclude it. Routing diagnostics are separate from prefix changes.

## Diagnostic fields

`provider_input_observed` describes the actual pre-send projection, not an estimate/unsubmitted draft.

| Field | Meaning |
| --- | --- |
| `cacheRouting.mode` | `session` sends a routing key; `provider_default` does not |
| `cacheRouting.keyDigest` | Key digest for stability comparison, not its original value |
| `images.count` | Full logical image count, including historical images during continuation |
| `images.remoteCount` | HTTP(S) images; an unchanged URL does not prove unchanged pixels |
| `images.comparisonAvailable` | Comparable preceding diagnostics in the same protocol |
| `images.addedCount` / `removedCount` | Image-block digest/multiplicity changes; repeated added copies count |
| `prefixComparisonAvailable` | Directly comparable history exists; false on first request/protocol projection change |
| `frozenPrefixBreak` | Comparable historical items rewritten/inserted/truncated; appending is not a break |
| `breakIndex` / `messageBreakIndex` | First real history break, not forced to zero for parameter changes |
| `parametersChanged` / `changedParameters` | Parameter changes/field names independently of history, without raw values |
| `projectionFormatChanged` | New projection format establishes a baseline rather than implying rewritten history |

Runtime `cache_chain_observed` makes the same distinction. Output limit, temperature, reasoning, model, binding or top-level tool changes are parameters. If history also changes, both facts are recorded with the actual message index. Provider top-level `system`/`tools` can affect caching but are not message-array rewrites. `parametersChanged=false` is not a cache hit.

Only per-parameter digests are added to state. Old checkpoints can compare an aggregate digest but cannot invent changed field names on the first comparison; later ones can. `sharedPrefixDigest` depends only on shared items, not parameters.

Legacy events lacked `prefixComparisonAvailable` and sometimes conflated parameters with `frozenPrefixBreak`. `cacheChainChanges` uses retained independent prefix counts to identify structural changes and leaves insufficient parameter evidence unknown. It skips message comparison across projection formats. Replay reports separate `structuralBreaks`, `parameterChanges`, `projectionChanges` without editing logs.

Image diagnostics inspect real image blocks in all three protocols, including user/tool images, not JSON-looking prose. Projection state stores comparison digests, not extra pixels, URLs or prompts. Digests include detail options. Judge replaced versus added images together with prefix facts, not count alone.

Old sessions/protocol changes establish a first image baseline with `comparisonAvailable=false`, not falsely counting all history as new. Comparisons include failed attempts: retrying identical images after a failed request has `addedCount=0`. Trace the earlier introduction rather than assigning it to an image-free request.

`model_request_usage.providerInputSequence` points to the exact same-Turn `provider_input_observed.sequence`, including the final compatibility retry and usage received before guidance interruption. Older adapters without these facts do not invent them.

Associate those events first, then group by new images, prefix state and routing. Actual hit ratio is provider-reported `cachedInputTokens / inputTokens`, not local digests. Correlation with images does not prove a provider's internal invalidation cause.

## Verification and limits

Local fixtures/mock responses cover real SDK bodies, concurrent sessions, retry/restart stability, all image protocols, old state, tool continuation and interrupted-request usage association. They do not resend users' histories to a provider.

Routing may direct a session to an instance with reusable cache, without guaranteeing hits. Measure subsequent real traffic, especially requests adding images; no fixed percentage is promised. Contracts: [Ark Responses](https://docs.volcengine.com/docs/ark/create-model-responses-api?lang=zh), [Ark Chat](https://docs.volcengine.com/docs/ark/chat-api?lang=zh); OpenAI fields also follow the installed SDK's streaming parameter types.

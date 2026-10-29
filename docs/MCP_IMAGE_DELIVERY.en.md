# MCP images and Chrome screenshot diagnostics

[English](MCP_IMAGE_DELIVERY.en.md) · [简体中文](MCP_IMAGE_DELIVERY.md)

[中文](MCP_IMAGE_DELIVERY.en.md) | [Documentation](README.md)

Native MCP results remain in execution records. Model-facing tool text removes binary data from standard image blocks, embedded image resources and image Data URIs; images use the existing vision channel.

## Image path

1. Direct MCP and `call_tool` standard `content[].type=image`/embedded image resources enter `ModelImageStore`. User-only images are not automatically attached to the model.
2. Shared validation/compression/persistence uses content addressing: at most four million pixels, 4096 longest edge and a target of 1 MB. Native receipts are unchanged.
3. At most 16 images/64 MB source data are processed per result; at most four distinct images attach per round, subject to remaining context and `requestCapabilities.vision`.
4. Tool text includes `runtime_image_files`. Internal `tool_image_observation` identifies source call, index, local path and `attached`, `vision_disabled`, `attachment_budget` or `failed`. Paths permit later explicit injection.
5. Providers project persisted paths into image inputs. Base64 is not ordinary tool text and need not be rewritten by the model.
6. New archives retain paths. Reading older native-image archives materializes the same files on demand and removes encoded image text. Persisted history reuses paths after restart.

Sending, counting and estimation share Runtime-issued read capabilities for current-context images. Snapshot reads validate store directory, real path, size and hash, without a new file-sandbox process for every replay. Knowing/mentioning a path does not grant access. New external files still use authorization, race protection and sandboxing. Read failure never falls back to unrestricted host reads.

Each projection deduplicates sources and reads serially with cancellation. Temporary resource-admission refusal retries only not-yet-started reads up to three times, at 500/1000 ms intervals. Exhaustion retains codes such as `resource_memory_pressure` and retryability rather than claiming corruption/reinjection is needed. It neither reruns completed tools/images nor lowers resource thresholds.

## Quality and capacity

- User previews read originals. At 100%, one source pixel equals one CSS pixel; Fit is separate. Tall images support true 100%, and resizing the window preserves manual scale.
- New observations already within four million pixels/4096 edge/1 MB without rotation retain original bytes. Oversized non-JPEG images first try lossless PNG at the permitted size, then lossy JPEG/WebP and further scaling if necessary. Alpha, orientation, animation and decoding limits remain.
- Persisted observations never re-encode on later requests/restart. Lost detail in older copies cannot be recovered by `detail: high`; crop from originals or use `inject_image_input(original: true)` within 9 MB.
- File bytes and vision tokens are distinct. Lower JPEG quality does not imply proportional token savings. Full API bodies include Base64, messages and schemas, with 40,000,000-byte hard limits and maintenance at 87.5% (35 MB), overridable via `maxRequestBodyBytes`. Token pressure uses shared maintenance too.
- Exact counts are used where supported; capability/history usage help calibrate estimates. Local image-token estimates are approximate, not a universal billing formula. Model fallback compaction preserves complete exchanges, image provenance and source summaries before atomic commit. See [image/request budgets](MODEL_IMAGE_BUDGET.en.md).

## Screenshot timeout

Extension `Page.captureScreenshot` returns `screenshot_timeout` after 25 seconds, before the bridge's default 30-second timeout. Timeout does not prove Chrome cancelled the command. Another screenshot on that tab returns `screenshot_in_progress` until the original finishes; other operations remain available.

Completion or debugger detachment clears occupancy. Disconnect returns `screenshot_interrupted`; a late old command cannot clear a new connection's occupancy. Running commands have no hidden retry.

Receipts record cumulative times for page selection, connection, handshake, extension receipt, permissions, debugger attachment, command execution and response. `details.diagnostics.stage` is the last reached stage; screenshot results/errors include `timings`. Older extensions without stage events expose only observed connection phases.

Consecutive failures for one session/page include `consecutiveFailures`, `cumulativeAttemptMs` and `failureWindowMs`. From the second failure, guidance suggests another preview path or connection inspection. Successful screenshot, navigation, page close or connection release resets those records. This does not cap total calls or change other sessions.

Diagnostics enter normal execution records without additional page bodies, screenshot encoding, tokens or command arguments. A stage locates waiting but does not independently establish Chrome's internal root cause.

## Verification

- Runtime: direct/indirect calls, archives, corrupt images, vision disabled, counts/compression and unchanged native output.
- Providers: small/large images, removed originals and restart replay.
- Extension/bridge: reentry, timeouts, late replies, disconnect/reconnect and stage attribution.
- Original September 13 SVG replay records remain in the Chinese guide: text-size reduction measured characters, not tokens; two later live captures did not reproduce the timeout, so its root cause was not declared established.

A build does not restart a running app. Restart CardBush for Runtime changes; reload the CardBush browser extension or restart Chrome for extension background changes.

# Model images and request-size budgets

[English](MODEL_IMAGE_BUDGET.en.md) · [简体中文](MODEL_IMAGE_BUDGET.md)

[中文](MODEL_IMAGE_BUDGET.en.md) | [Documentation](README.md)

Image tokens and encoded bytes have no fixed ratio. Vision tokens depend on model, pixels and detail; HTTP bodies also contain Base64, text, tools and arguments. Check context tokens and full UTF-8 request bytes separately, without treating Base64 length as actual token usage.

## Importing images

`ModelImageStore` creates immutable copies when user attachments, `inject_image_input` or explicitly `model_input` tool images enter context. Defaults: four million pixels, 4096 px longest edge and 1,000,000 encoded bytes. Preserve aspect ratio without cropping/upscaling; avoid repeated lossy encoding of small images. Ordinary images use JPEG, transparent images use alpha-preserving WebP, and EXIF orientation is handled.

Original files/UI preview URLs remain. Copies are addressed by content SHA-256; history references those paths. Later requests, restart and prefix replay do not recompress them, including legacy snapshots.

`inject_image_input(original: true)` explicitly reads original pixels within a 9,000,000-byte limit. Default compression accepts source files up to 64,000,000 bytes and decoding up to 64 million pixels. Extract relevant animation frames or explicitly choose original; large animations do not silently become frame one. Providers fetch remote URLs; the host does not download them. Decode failure reports an error, never an unbounded-original fallback.

## Complete request budget

Responses, Chat Completions and Messages default to **40,000,000 bytes**, increased from 32,000,000. This local dispatch budget is not a claim about each provider's actual limit. Context tokens remain separate.

Adapter construction may override `maxRequestBodyBytes` with a positive integer for known transport limits. Serialize actual projected JSON and measure UTF-8 including Base64. Maintenance begins at 87.5%: 35,000,000 bytes by default; 40,000,000 is the hard dispatch limit. Counting and sending check the same budget.

On token/byte pressure, ordinary Agent sessions first try recorded-tool handoffs, then fall back to model `checkpoint_context` when safe reduction cannot fit. Both progressive and legacy model transactions split only at complete messages/tool exchanges, preserving reasoning, parallel calls and all receipts. Progressive processing retains global source IDs, stages partial summaries, then merges each full source and atomically commits all sources. Original history, real calls/receipts, boundaries and recovery state persist across restart. Unsplittable messages/final merges fail explicitly, never truncating originals into a falsely complete summary. See [Context and memory](CONTEXT_AND_MEMORY.md).

Token fields in `model_request_usage` remain actual provider usage; request bytes/limits are separate `requestBody` diagnostics and do not enter model-input fingerprints.

## Verification

Coverage includes dual budgets, all three APIs accepting 32–40 MB bodies and blocking above 40 MB, formerly oversized images, alpha/orientation/animation, high-pixel small-byte files, originals, attachments/tool observations, source deletion, persistence/restart, low-token high-byte segmented maintenance/continuation, source isolation and atomic commit.

The original September 13 record retains a 16-image local encoding comparison (37,582,379 to 7,157,037 file bytes; Base64 50,109,860 to 9,542,732, approximately 81% lower, unchanged resolution). This was not a model call or measurement of provider vision tokens.

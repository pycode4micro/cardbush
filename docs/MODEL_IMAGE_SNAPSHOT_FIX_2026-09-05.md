# Model image observation lifecycle

## Confirmed failure

Session local-4cb41567-c4a5-47da-9cc9-1ef3400bfa3d failed after a Tool deleted
visual-esports-current.png. A previous successful inject_image_input had retained
that mutable path in a tool_image_observation message. The provider reread the
historical path on the next request and failed before any network submission.
The replacement screenshot was not ready when the terminal command checked it.

Overwriting the same filename was also unsafe: it changed historical image bytes
without changing the path checked by CacheChainTracker.

## Bounded fix

- ModelImageStore captures local image bytes when an observation is accepted.
  Runtime owns the content-addressed files under dataRoot/model-images.
- inject_image_input validates and snapshots before returning success.
  Its definition, arguments, brief success receipt and original artifact path
  are unchanged. Runtime-only model_input_url metadata identifies the snapshot.
- Other explicitly opted-in image artifacts are captured at the Tool-result
  boundary, before another sequential Tool can delete their sources. Native
  outcomes remain untouched; failed image delivery is a separate factual
  tool_image_observation, not a fabricated Tool execution failure.
- Failed injection receipts retain runtimeError, so the model can see why the
  input failed and retry after producing a complete file.
- Each read is bounded to 9 MB plus one growth-detection byte, checks file size
  and modification time, and checks the existing raster signatures/completion
  markers (including RIFF/BMP declared lengths). This is not a full image decoder.
  There is no fixed delay, automatic screenshot regeneration or model retry.
- Snapshot bytes are flushed before atomic, no-replace publication; concurrent
  identical observations deduplicate. Source overwrite/removal never updates an
  already accepted observation. Persistence stores the snapshot path, not base64.
- Provider projection uses the same bounded reader. A missing legacy input is
  now an explicit, non-retryable image_input_unavailable error, not an apparent
  provider outage.

## Compatibility and limits

No Tool schema, roles, compaction thresholds, retry policy or existing session
journal is rewritten. HTTP/data URLs and direct user attachment handling are
unchanged. No prompt-prefix workaround or per-request historical replacement
is used; stable image bytes preserve the same provider input across rounds.

Already deleted legacy source bytes cannot be reconstructed by this change.
Do not substitute a newer screenshot for a previous observation. Recovery of
such a session requires explicitly restoring the original bytes or an explicit
conversation-context recovery, outside this patch.

Snapshots belong to persisted Runtime state, not an expiring browser cache.
Do not expire them while sessions/checkpoints reference them. This patch adds
content deduplication, not a new garbage-collection or migration system.

## Offline regression coverage

- Source overwrite and deletion; unchanged original snapshot after store restart.
- Concurrent identical injection, complete publication, no temporary residue.
- Existing snapshot integrity mismatch is not silently overwritten.
- Missing, partial, unsupported, directory, oversized and cancelled local inputs.
- Opt-in artifact selection and existing image-ingress budget behavior.
- Native Tool facts and compact receipts remain intact; actionable failure/retry.
- Real Runtime Tool loop, disk session journal and provider input projection:
  inject, delete source, continue the same Turn, reopen, and replay identical bytes.
- Cache-chain observations remain unbroken across all three requests of that Turn.
- Missing legacy image fails locally with zero network attempts.

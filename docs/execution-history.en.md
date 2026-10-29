# Time and execution-history search

[English](execution-history.en.md) · [简体中文](execution-history.md)

[中文](execution-history.en.md) | [Documentation](README.md)

The system prompt keeps one fixed rule: use a terminal tool when the task needs the current date, time or timezone. Parent and child Agents share it; no `session_environment` date message is automatically appended.

## `search_execution_history`

Supply 1–3 keywords and a short description. Local identifier matching and BM25 term matching search summaries without another model call or requiring every keyword to match:

```json
{
  "keywords": ["verify_4k", "coverage"],
  "description": "Find earlier checks of the head mask coverage"
}
```

- Scope is nondeleted conversations in the current project, or only the current conversation without a project. Worktrees use source-project ownership. Arbitrary model-supplied project/session IDs cannot broaden scope.
- Each page returns at most five summaries with stable record ID, recorded time, tool, execution state and matched keywords. Keep the query unchanged and use `next_offset` for more.
- Complete identifiers such as filenames, paths, delimited tool names and dates rank first (`match_type: identifier`), then other keyword matches (`keywords`), then related description/term matches (`related`). A page does not mix tiers to fill five slots. No exact match falls through to the next tier; no match yields `none`. Pagination reaches all candidates without merging events or removing failed/cancelled records.
- Identifiers normalize Unicode, case and slashes and match alphanumeric boundaries: `exe` does not match `exec`. Terms use explicit identifier splitting and adjacent CJK character pairs rather than Node/Electron `Intl.Segmenter` dictionaries. Ordinary `learn` retrieval is unchanged.
- `recorded_at` is receipt insertion time, not overall task start/completion. `returned` means only that a tool returned. Summaries retain original errors/explicit status without deciding task success for the model.
- Summaries are at most 640 characters, from identifier arguments, changed paths and short result excerpts. File records retain original `purpose` and the first three `points`; result `note` takes precedence over input. Long paths shorten the middle to retain the filename. Notes are not independently validated. Search does not directly return file bodies, image data, rollback snapshots or diffs. Where an original result exists, a `tool-result://history/...` locator lets `read_archived_tool_result` page or search it under the same conversation/project scope. Deleting the source invalidates it.
- Retrieval uses visible terms, not guaranteed semantic synonyms. No match does not prove an operation never happened; try different keywords.
- Search's own execution records are excluded to avoid recursively finding prior searches.

## Storage and compatibility

New tool logs store separately validated lightweight summaries before large payloads. Full records and existing read interfaces remain unchanged.

The first query creates a rebuildable `.jsonl.history` index alongside that session's tool log; later queries process only appended segments. Search does not `load()` the whole journal or restore cold diffs/rollback data. Project ownership reads lightweight session metadata instead of full snapshots.

Summaries/indexes are versioned. Old indexes rebuild from original logs on the next query, and old headers do not prevent new purpose/point fields from being recovered. Original logs are not rewritten. Current headers avoid reparsing large payloads.

Old headerless logs are read/validated record by record during initial indexing. Legacy records over 16 MiB are skipped and counted in `unindexed_oversized_records`. If an oversized record already has a validated older summary, it is retained and counted in `unrefreshed_summaries`. Current headers do not have this legacy backfill limitation. Incomplete log tails are not execution facts.

Indexes share session cleanup ownership. Deleted sessions disappear from search; unreferenced-cache maintenance also reclaims indexes. Results use independent record IDs without external-session references, so a search cannot accidentally retain an entire deleted session. Summaries enter context only when explicitly searched, not through automatic user-message/prefix injection.

## Verification

`npm run test:execution-history` covers summary bounds, exact/related ranking, tier pagination, execution states, legacy migration, oversized records, project isolation and ordinary logic retrieval, comparing identical Node/Electron queries.

`node scripts/replay-execution-history.mjs <sessionId> <turnId> [runtimeRoot]` read-only replays current-session queries from committed Turns against records available before each query. It compares response size/candidates and all-page cross-runtime consistency. Index migration happens only in temporary copies, without executing historical business tools. Reports contain summary counts, IDs, tool names, terms and verification digests, not raw result links or complete conversations.

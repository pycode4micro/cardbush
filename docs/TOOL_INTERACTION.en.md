# Tool interaction and result navigation

[English](TOOL_INTERACTION.en.md) · [简体中文](TOOL_INTERACTION.md)

[中文](TOOL_INTERACTION.en.md) | [Documentation](README.md)

These capabilities live in shared Runtime. Local/cloud Agents use the same protocol; direct SSH file/search/terminal operations support corresponding parameters.

## Unified invocation

Built-in and MCP business tools use `call_tool({name, arguments})`. With an exact name, first read `get_tool_schema({name})`, wait for/read its result, then invoke. Reuse definitions still in actual context. Discover unknown MCP tools with `search_plugins({mode: "mcp", query})`; batch-load known names through `get_tool_schema({names})`. Discovery, archive and maintenance tools follow their returned `invocation` directly, without nested dispatch wrappers.

Old `mcp_call`, `parallel_tools`, separate task-management tools, synchronous questions and preauthorization entries were removed, without aliases or legacy-result adapters. `tasks` observes/waits/stops/reads children; `team` defines/starts/resumes workflows; questions use `request_user_input_async({questions})`. Actual target scope, revision, approval, Hooks, locks and cancellation are still checked. Loading a schema grants no permission. Scripts use `tools.call(target,args)`. Product policy v9 rejects obsolete tool contracts: clear old history/start a new session instead of migrating/replaying old calls.

## MCP discovery

`search_plugins` returns short summaries, loaded state and pagination. Fixed instructions belong to definitions rather than repeated protocol/session/server/underlying-name fields. Native execution records retain full facts.

Search matches whole terms, ignores common English stop words and prioritizes exact tool names, useful-term coverage and tool/server names, avoiding matches such as `web` inside `webp`. Browser Use descriptions include current-information/news searches through search-engine pages. Only visible session tools are searched; partial/no matches do not establish that browser capability is unavailable.

Start with `query` (`*` lists the catalog; optional `server` narrows it). Follow `next_cursor` unchanged as `cursor`, optionally changing `limit` but omitting query/server/numeric offset. Cursors bind query/session/sort results. New queries or changed relevant catalogs require restarting. Reading the same cursor returns the same page and does not hide previously seen tools. Model results retain `more`/`next_cursor`.

At Provider dispatch, `get_tool_schema` results omit protocol/session and false `more`, identically for ordinary calls/native tool search. Complete schema, revisions, pages, batch errors and `deferred` remain. Runtime history retains original identities for reconnect/compaction/recovery; saved messages and large archived bodies/offsets remain unchanged. Ordinary receipts and Hook replacement content are unaffected.

Built-in producers of `next_step` / `nextStep` action advice and the old Runtime / Provider filters for these fields have been deleted, without renaming or hiding the fields. Tasks still return current status, revision, results, controls and pagination. Browser and computer operations retain connection, execution-boundary and actionability facts, with permission and safety checks enforced. No generic field filter was added; saved user history and raw third-party output are not rewritten. See the [local action-guidance audit](RUNTIME_NEXT_ACTION_AUDIT_2026-11-15.md) for remaining mechanisms.

```json
{"names":["mcp__server__first","mcp__server__second"]}
```

Batch loading accepts at most 16 names and deduplicates them. Successful entries contain full schemas; missing/ambiguous/invisible entries report distinct errors. Entries beyond the batch display budget go to `deferred` without being marked loaded. A single huge schema uses the existing archive path. `name` and `names` are exclusive. Receipts use `bush.tool_schema.v1`; old MCP loading receipts no longer restore definitions. After compaction, only complete schemas still in actual context count as loaded.

## Results and history

First-party tool receipts no longer generate `next_step` / `nextStep` action hints. Task IDs, states, revisions, pagination, error codes, dispatch facts and observations retain their existing structures; Runtime manages waiting, cancellation and completion delivery. Tool usage rules stay in definitions rather than returning removed hints under another name. Browser host health records project only state, diagnostic time, error code, error message and whether automatic recovery is paused; action hints from older records are not forwarded to the model. Saved conversation history and external plugins' original business data are not subject to global field removal.

The equivalent repeated advice in `route_recovery.instruction` and Computer Use error `recovery` text is also removed. Repeated-call counts, corrected call structures, user-takeover timing, dispatch facts, permission checks and stop enforcement remain.

User message prediction uses `userMessagePrediction` across protocol types, derived Runtime snapshots and the shared ordinary/assistant composer. The module, Hook, prompt resource, test entry and CSS state class are renamed without old entry points or export aliases; the unused prediction-button language key is removed. Package exports, CLI, build and release test references are updated. `summary_for_user.prediction`, the `prediction` memory category, personalization switches and accepted-draft state keys remain unchanged. Restart restores predictions from original calls and receipts without rewriting history. Accepting a suggestion still inserts an editable draft without sending it.

The cleanup audit retains old-receipt filters in `mcpToolDiscovery` and Provider `modelInputs`: they still consume historical and archive-restored data and prevent old `next_step` instructions from reaching the model. Historical fixtures, absence assertions and invalid-prediction text checks remain valid coverage, not retired guidance generators.

Local `dist/assets` retains historical content-addressed assets under the existing Vite policy because open windows may still need their lazy imports. This cleanup does not clear those windows' resources. Current build outputs contain no old prediction names; standalone compiled files for the old module are removed.

`read_archived_tool_result` accepts a case-insensitive literal `query`, `context_chars` and `limit`, returning match `offset`, `end_offset`, `context_offset` and context. Follow `next_offset`; omit query and use a match offset to read exact original text. Fragments are not complete schemas.

`search_execution_history` pages at most five summaries, with `tool-result://history/...` when full originals exist. Resolution stays in the current conversation/project; cross-project access is denied and source deletion invalidates references. References cannot keep deleted-session caches alive. Old indexes upgrade without rewriting execution logs.

## Plans

`update_task_plan` supports `get` (plan/revision or null), `replace` (full nodes), and `patch` (required `expected_revision`, ID-based `updates`, `append_nodes`, `remove_ids`; omitted content stays intact).

```json
{"action":"patch","expected_revision":2,"updates":[{"id":"existing-node-id","status":"completed"}]}
```

Writes are atomic. Revision conflicts, invalid/duplicate IDs or more than one in-progress node reject the whole update. Removing nodes from an active plan still requires `scopeChangeReason`.

## Files

`search_file_content` supports `context_before`/`context_after`, each 0–100 lines, default zero, across ripgrep/local fallback/direct SSH.

`edit_file` offers exact-text matching or one-based inclusive `start_line`/`end_line` with `expected_sha256` from `read_file`. `new_text` replaces the whole selected lines, including their original endings. Modes cannot mix; stale hashes/out-of-range bounds fail.

No/ambiguous matches, stale versions and invalid ranges explicitly mean no write. Do not repeat identical failing arguments: reread current text/hash, then select unique text or a range. Use `replace_all` only when every occurrence should change. Local/standalone/SSH share guidance, including SSH host-error transport. Whitespace/indentation/content checks are not automatically relaxed.

See [background continuation](ASYNC_TOOL_AND_SUBAGENT_CONTINUATION.en.md) for terminal completion. Results append without rewriting sent messages or the Turn tool snapshot. Run `npm run test:tool-invocation` for invocation/recovery/permissions and `npm run test:tool-ergonomics` for interactions.

# Streaming display and history comparison

[English](streaming-lab.en.md) · [简体中文](streaming-lab.md)

[中文](streaming-lab.en.md) | [Documentation](README.md)

Run `npm run preview:streaming-lab` for a loopback-only preview URL, and `npm run test:streaming-lab` for automated verification.

## Local history

`npm run preview:streaming-lab -- --history` reads local runtime-state without mutation, selecting the latest four parent-task Turns with complete snapshots by default. Filter with `--session <sessionId>`, repeat `--turn <turnId>` for exact records, or use `--runtime-root <directory>`. Missing original events fail explicitly.

For an existing preview, run `node scripts/export-streaming-history.mjs --turn <turnId>` and refresh. `--build-only` prepares files without replacing the running server/port. Export includes only replay event projections/results in ignored `tmp/streaming-lab/history.json`, never source-controlled personal history, Runtime restoration or historical tool execution.

Switch between real history and synthetic scenarios, with source task/Turn, original duration, event count and gaps. Normal replay retains order/intervals at 1/4/16/64×. Jump to completion waits each text/tool boundary, for result inspection rather than performance measurement. Accelerated/jump first-character numbers are not original-speed conclusions.

`node scripts/test-streaming-history.mjs` uses original intervals and a virtual 16 ms frame, writing `tmp/streaming-lab/history-results.json`. UI tests additionally inspect exported final text, child previews, guidance and no change-summary before the final Turn.

The left comparison uses `createSegmentedAssistantStreamBuffers` and 500 ms list batching. The right uses production `transcript/frameStreamBuffer`, releasing up to 24 Unicode code points per message per frame after arrival. Both reuse real `ChatPanel`, message/tool projections, change summaries and scrolling. Inputs are identical local events, with no model/tools/user-session writes.

Production send, control operations (including regenerate) and background subscriptions all use frame queues. Default `transcriptDelivery=frame` shows text/segment-complete markers immediately while pure tool status remains 500 ms batched. Tools/guidance synchronously release pending text before updating facts; Stop/final events drain queues. Subscription interruption preserves segment/event-ID checkpoints, avoiding duplicate prefixes or lost segments. Nonprefix snapshots use explicit body replacement without inventing loops or clearing tools.

The main app imports neither lab pages, scenarios nor personal exports. Old queues remain only for comparison/compatible exports.

## Regression coverage

- Text reaches visible chat before segment completion; completed segments still emit empty completion deltas for archival rules.
- Multiple segments, Chinese/emoji and burst deltas preserve ordering/surrogate pairs.
- Tool boundaries flush text immediately and retain `contentOffset`; guidance closes a process segment while keeping the Turn active, without final change summaries.
- Child/image previews appear independently during execution. Completion/Stop retain summaries; failure retains failure.
- Complete, guide, Stop, failure and long-Markdown scenarios agree before final snapshots and after duplicate snapshot merging.
- Hidden pages, final-before-last-delta, duplicate events, reset/dispose, nonprefix replacement and second-segment interruption/reconnect are covered.
- Tool-count batching, media DOM stability, immediate Stop/approval, session isolation, manual upward reading position, bottom-follow and theme switching are covered.

Output: `tmp/streaming-lab-ui-results.json`. First character measures entry into message state, not network first-token latency. React Profiler reflects local development builds, not a production benchmark. Use Start replay for streaming feel; Jump to completion checks boundaries/snapshots only.

The [original guide](streaming-lab.md#本次历史对照) retains the four-Turn historical comparison, timings and missing-record caveats. It is not retransmitted to a model. Extreme all-events-at-once tests verify that late tool-created messages inherit ended-Turn state and archived copies close correctly; `tmp/streaming-lab-burst-results.json` does not allow status differences.

Coverage includes three Hook integrations, continuation/snapshot revisions, final/guidance/history and scrolling. It excludes network and all production rendering overhead. Long-term parsing of extremely long Markdown still needs observation; the parser was not rewritten. Historical replay focuses on text/tools/guidance/final state, not reconstructing reasoning/plan UI or executing old HTML/BI content. Frame output is the production default; the lab remains a regression tool.

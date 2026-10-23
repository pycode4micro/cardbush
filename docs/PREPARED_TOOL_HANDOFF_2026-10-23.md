# Final-reply tool handoffs: branch implementation and live comparison

Branch: `codex/final-reply-compaction`, based on `3d7d7a8`.

## Behavior

`summary_for_user` has an optional static `tool_summary` field (at most 12,000
characters; recommended 300–800 tokens). The model records the current turn's
tool outcomes, artifact/job identities, failures, pending and unverified work,
continuing requirements, and versioned source locators/reread conditions.
It must not make new task decisions while summarizing. Existing `{}` calls and
ordinary conversation without tool work remain valid. Nothing forces a new
completion round. Optional habit/prediction writes remain independent.

The real final-tool call and receipt stay in the original journal. Source
validation uses the existing Skill version/range checker. Invalid references
produce `context_handoff.status = not_reusable` plus the observed source index
immediately; the model may correct once or finish with ordinary compaction as
fallback. Successful validation binds a SHA-256 to the exact summary and stores
only verified source references. This does not certify semantic correctness.

Before pressure, original messages remain the context. At pressure, Runtime
checks completed turns for a standalone successful final-tool call followed by
the actual final assistant prose. Later tools or user guidance invalidate that
preparation. Missing/failed/legacy calls, incomplete turns and superseded sources
are not reusable. Applied handoffs project as:

```text
original user/instruction messages
any existing checkpoint carrying earlier history
assistant: <tool_summary>model-authored tool handoff</tool_summary>
           exact final reply
```

Provider replay/reasoning is never attached to this combined prose. Original
messages are unchanged. The existing `turn_context_summarized` session event
stores canonical message references; Runtime lifecycle events distinguish
`prepared_tool_handoff` from `checkpoint`. On restart, the session projection and
runtime checkpoint are reconciled without rerunning tools. Fork rebases archive
locators and the handoff hash. Indexed history includes the same applied refs.

The complete candidate request is measured before application. It must reduce
input and meet the existing post-compaction target and request-body headroom.
Otherwise the existing checkpoint transaction selects an older prefix, keeps
recent complete exchanges, and applies its bounded no-progress guard. A long
unfinished active turn still needs that normal path. This feature does not solve
active-turn pressure by pretending the task has already finished.

Later checkpoint transactions rederive the handoff's verified source references
from canonical receipts, outside model messages, and reuse the existing source
index/validator. File versions and reread conditions therefore survive more than
one compaction. No runtime schema mutation or separate summary model, reasoning
setting, output ceiling, memory store, or dependency scheduler is introduced.

`preferPreparedToolHandoffs: false` on `InMemoryRuntimeHost` selects the previous
pressure-time algorithm for comparisons. Existing frozen tool contracts without
`tool_summary` use the previous path. Older binaries do not understand the new
session projection variant: this is an isolated branch, not a deployment or an
in-place migration of user session data.

## Live experiment

Follow-up: [long-session comparison with revisions and four consecutive pressure
boundaries](PREPARED_TOOL_HANDOFF_LONG_2026-10-23.md). That larger sample separates
actual post-compaction input usage from total-chain usage, identifies lost
inherited checkpoint facts, and shows prepared summaries accumulating more input.

Final controlled run: `tmp/prepared-compaction-live-20261023-d/report.json`.
The portable, sanitized result is in
[`prepared-compaction-live-20261023.json`](../packages/bush-runtime/test/fixtures/prepared-compaction-live-20261023.json).

- Actual configured provider: `deepseek-flash`, Responses protocol, `max`
  reasoning, unchanged 128,000 output-token ceiling.
- Configured context: 530,000 tokens. Only the synthetic test session budget is
  168,000; a controlled JSON-character counter triggers pressure. This counter
  is not the provider tokenizer. Usage below comes from provider usage events.
- Two synthetic multi-turn histories: video editing and service deployment.
  Each contains noisy tool observations, real-looking but fictitious IDs,
  versioned Skill snapshots, incomplete work and corrections.
- Both arms make real final-display calls. The baseline preparation uses a fixed
  legacy schema with `{}`; the new preparation writes `tool_summary`. At pressure,
  both arms use the same fixed current tool catalog and model settings.
- Final prose is fixed and identical in both arms, so its generation cost is
  excluded equally. No actual business tool, installed Skill, user session or
  configuration is modified. Rubric answers are not supplied to the model.
- 21 measured model rounds in the final run, including the stale-summary case;
  adapter-level wire retries are not independent benchmark trials. The order is
  fixed, caches/network are uncontrolled, and there is one final sample per case.

| Scenario | Path | Preparation | Pressure-time compaction | Audit turn | Total measured chain | Fact checks |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Video | On demand | 2.516 s | 17.725 s | 19.495 s | 22.011 s | 13/13 |
| Video | Prepared | 14.780 s | 0.011 s | 2.288 s | 17.068 s | 13/13 |
| Deployment | On demand | 1.796 s | 20.851 s | 25.206 s | 27.002 s | 16/16 |
| Deployment | Prepared | 23.928 s | 0.009 s | 1.933 s | 25.861 s | 16/16 |

The audit turn includes compaction plus the answering request; do not add the
compaction column again. Total is preparation + audit, excluding identical fixed
final prose generation and synthetic business work. Compaction is timed from
the existing started/completed events; candidate selection and admission before
the started event are included in the audit-turn total, not that narrower column.
The millisecond figures therefore do not represent full answer latency.

| Scenario | Path | Model rounds | Reported input tokens, including cached | Reported output tokens |
| --- | --- | ---: | ---: | ---: |
| Video | On demand | 5 | 104,748 | 3,602 |
| Video | Prepared | 3 | 46,931 | 3,065 |
| Deployment | On demand | 7 | 166,182 | 5,044 |
| Deployment | Prepared | 3 | 47,700 | 4,550 |

An additional user correction was placed after preparation: render R-12 was
cancelled, draft V-13 had no submitted render. Runtime rejected the stale handoff,
used ordinary compaction and passed all three correction checks. No pending job
was automatically resubmitted. Versioned reference continuity, mid-application
crash recovery and incomplete active turns are also covered offline.

Exploratory runs are retained in `tmp/prepared-compaction-live-20261023-a` through
`c`. Run `a` failed before generation because synthetic tool calls lacked the
reasoning envelope required by this configured API; labeled fixture envelopes
were then added without changing model settings. Run `b` exposed invalid source
links and a semantic mistake: workflow ordering was reinterpreted as a media
timestamp. That led to immediate reference feedback and clearer preservation of
temporal conditions. Run `c` exercised correction receipts successfully; one
baseline deployment compaction exhausted reference corrections and safely failed.
These outcomes are not omitted or treated as proof of universal superiority.

The demonstrated benefit is shifting work away from the pressure boundary. Both
final arms preserved every graded fact, so this sample does not establish better
semantic retention. Preparation consumes time even if a session never reaches
pressure; long unfinished turns and stale summaries retain the previous cost.
Keep the hybrid fallback and measure larger real-task samples before making a
general speed or quality claim.

## Reproduction

```powershell
npm run build --workspace @cardbush/bush-protocol
npm run build --workspace @cardbush/bush-runtime
npm run build --workspace @cardbush/bush-product-agent
node --test packages/bush-runtime/test/preparedToolHandoff.test.mjs
node scripts/probe-prepared-compaction.mjs --output tmp/a-new-probe
# Only the following explicit opt-in sends real model requests:
node scripts/probe-prepared-compaction.mjs --live --output tmp/a-new-live-probe
```

The output parent must exist and the output directory must be new. The probe
reads the existing default model config without displaying credentials. Requests
and visible tool arguments/replies are saved with hidden reasoning/replay removed.
It stops after at most 30 model rounds and bounds each request's duration.

Validation: 362 distinct offline tests passed across context budgeting,
compaction, memory/final display, session persistence/indexing/recovery, protocol
and provider replay, including 24 new handoff tests. The checkpoint presentation
check passed. Protocol, Runtime and Product Agent builds passed; Product Host and
Runtime Electron type checks passed. No real business execution or deployment.

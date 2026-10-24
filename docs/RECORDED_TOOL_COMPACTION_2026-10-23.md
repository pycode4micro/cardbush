# Recorded tool compaction — implementation and live evaluation

Branch: `codex/recorded-tool-compaction`, based on `dee6c665`.

## Behavior

Neither the system policy, personalization context nor the current
`summary_for_user` schema asks for a per-Turn recap. The original v3 policy made
the tool optional for habits/predictions. Policy v4 (2026-10-24) restores its
independent final-display role: after other tool work, call it alone before the
final reply, using `{}` when memory is disabled or there is nothing new to record.
Conversation without tool work needs no call. This does not restore `tool_summary`
or change recorded compaction; old calls/receipts continue to decode.

When context pressure is reached, Runtime first tries a deterministic projection:

- Preserve original user instructions, corrections and exact final reply text.
- Record each tool's name, existing `reason` or display title, arguments, result,
  call ID and receipt message ID. No new model-authored field is required.
- Retain failure/denial diagnostics, pending jobs, exit codes, nested batch results,
  artifact IDs, permissions and unknown metadata. Tool return is not task success.
- Excerpt only large known text payloads, marking omitted characters and attaching
  a `conversation-history://` locator. Preserve unstructured receipts and failure
  diagnostics rather than guessing which parts are significant.
- Preserve Skill/instruction source exchanges, image exchanges and earlier
  checkpoints. Reuse existing Skill source validation when model compaction is
  subsequently needed.

The candidate must reduce the complete request and meet token/body headroom.
Insufficient savings, long unfinished Turns and ineligible history use the existing
model checkpoint transaction. Preparation does not rewrite history after every Turn.

Applied projections are versioned (`recorded_v1`), bound to a digest of original
visible facts, and persisted through the existing `turn_context_summarized` event.
Original journals remain available. Restart, fork, supersession and source changes
are covered by regression tests. Hidden reasoning/replay is not copied to synthesized
messages. No business tools are rerun to rebuild history.

Policy v4 migrates old bound v2/v3 conversations once at the next Turn boundary,
updating the system policy and `summary_for_user` presentation atomically through
`model_contract_updated`. Other tool definitions remain frozen. Ordinary subsequent
Turns retain append-only prefixes; this explicit migration and actual compression
are expected cache-prefix boundaries.

## Real provider comparison

Used the locally configured `deepseek-flash` through `openai_responses`, with its
existing provider-default reasoning and 127,998 output-token allowance. Configuration
was not changed. All arms received identical source facts, final replies, tools and
audit questions. The test reduced the simulated context window to trigger production
compression. Its JSON/4 pressure counter is a controlled test input, **not a provider
tokenizer**; the token numbers below are actual provider usage.

The first experiment used two fixed synthetic histories, not user conversations.
Business operations were not executed. Expected answers were hidden from the model.
Each arm ran once; these are case results, not a statistical performance claim.

| History / method | Model calls including continuation | Extra checkpoint calls | Continuation input tokens | Fact checks | Total elapsed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Video / original history | 1 | 0 | 25,893 | 13/13 | 3.78 s |
| Video / model checkpoint | 3 | 2 | 7,018 | 12/13 | 17.43 s |
| Video / recorded tools | 1 | 0 | 4,605 | 13/13 | 2.84 s |
| Deployment / original history | 1 | 0 | 26,017 | 16/16 | 3.34 s |
| Deployment / model checkpoint | 3 | 3 | No continuation | Failed during checkpoint | 21.08 s |
| Deployment / recorded tools | 1 | 0 | 4,729 | 16/16 | 2.20 s |

Recorded projection reduced continuation input by **82.2%** and **81.8%** relative
to original-history controls. No preparation/model-summary calls were made.
Local compaction lifecycle time was 6 ms and 2 ms; it does not include all preceding
candidate construction/token measurement and should not be treated as total CPU cost.

The model-checkpoint video answer lost `V-12`; the deployment arm exhausted its
checkpoint attempts. These failures are retained in the report rather than rerun
until passing. The fallback remains model-dependent.

Two boundary probes also ran:

- New user correction after an old final reply: 3/3 checks, including cancelling
  the pending job and changing the draft version. No checkpoint call.
- Opaque, oversized tool output: deterministic projection was not applied; the
  existing model fallback made two checkpoint calls, resumed and passed 13/13 checks.

## Model-authored tool loop

A second experiment let the real model create the history itself. It called an
isolated fixture tool, read an existing render ID and a failed audio check, then
finished normally. It used **two requests: tool invocation and final response**,
with no `summary_for_user` call. Fixture operations read synthetic local values;
no real render or publication was performed.

The resulting real tool transcript was reused in original-history and recorded
arms. In both, the model correctly called `fixture_status` with `render-602`,
without resubmission. Both passed 6/6 result checks and made no summary calls.

| Continuation | First request input | Total input across two requests | Result checks |
| --- | ---: | ---: | ---: |
| Original history | 8,503 | 17,319 | 6/6 |
| Recorded tools | 4,407 | 9,253 | 6/6 |

The first continuation request was **48.2%** smaller. This exercises actual tool
selection after compaction, not just extraction of facts into a final answer.

## Reproduce and inspect

Validation: 311 related tests passed, including context budgets/admission,
recorded and historical handoffs, source evidence, recovery/fork/history,
personalization and policy migration. Full application build, Node type checking
and checkpoint UI projection checks passed. Live evaluation made 20 provider
requests across the two experiments.

```powershell
npm run build:runtime
node scripts/probe-recorded-compaction.mjs --live --output tmp/recorded-comparison-new
node scripts/probe-recorded-compaction.mjs --live --loop-only --output tmp/recorded-loop-new
```

Omit `--live` for fixture/config preparation without provider calls. Output paths
must be new directories. Each live run is bounded by request/time limits. Reports
save visible messages, usage, compaction lifecycle and hidden-rubric results, never
credentials or hidden reasoning. User sessions and model settings are untouched.

Sanitized result fixtures are in
`packages/bush-runtime/test/fixtures/recorded-compaction-live-20261023.json` and
`packages/bush-runtime/test/fixtures/recorded-compaction-loop-20261023.json`.
Raw local requests/responses are under `tmp/recorded-compaction-live-20261023/`
and `tmp/recorded-compaction-loop-20261023/` (not versioned).

Unknown large text, full instruction sources and large metadata arrays can still
require model compression. Excerpts are not complete evidence: the model must
reread the original receipt before using an omitted detail. The implementation
does not claim a semantic summary can always be generated without a model.

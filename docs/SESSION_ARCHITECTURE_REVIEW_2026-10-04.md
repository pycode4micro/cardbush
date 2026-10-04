# Session architecture review — 2026-10-04

Reviewed local session `local-017dc07c-a44b-49c0-95c6-d92b1a88d55f` using
persisted turn, tool-execution and event records. This review concerns host
architecture, not the model's tool selection or task competence.

## Evidence

- The session contains 10 `resource_memory_pressure` admission failures. These
  occurred before launching the requested process. Old receipts contain no usage
  figures, so they cannot distinguish exhausted physical RAM from shared-budget
  or system commit pressure.
- A newly installed download plugin completed discovery but remained
  `waiting_for_idle`. Catalog publication waited for the entire active turn,
  leaving the model unable to use the new plugin in that turn.
- The video service lost its connection after reporting 271 rendered frames
  (21.34%). Its restarted service reported the job interrupted. A subsequent
  job also stopped at zero frames. There is no native exit receipt in those
  historical records proving whether a memory limit caused either exit.
- The final pause guidance was submitted at 03:47:13.704 UTC and applied at
  03:47:13.792 (88 ms). New reasoning started at 03:47:15.661; visible text began
  at 03:48:22.460. This was not a hardcoded 30-second guidance delay. The UI had
  sealed the preceding assistant segment but had no new reply component mounted
  to render reasoning during the roughly 67-second gap.

## Changes

- Persistent service memory ceilings no longer inherit a temporary low-memory
  admission snapshot. The 25% individual and 50% shared ceilings, startup checks,
  and live pressure backstop remain. This fixes an inappropriate lifetime limit
  without claiming the existing percentages fit every video workload.
- Admission errors identify the limiting budget and measured byte counts. MCP
  exits preserve native resource reports through tool errors and supervisor logs.
  Recovering a connection explicitly does not resume an interrupted background job.
  A timestamped failure remains available in the MCP snapshot after recovery.
- Optional new MCP services publish during active turns. Product conversations
  refresh additive discovery scope at round boundaries; provider tool definitions,
  approvals and restricted child/scheduled scopes retain their existing contracts.
  Replacements/removals still wait for idle.
- Guidance feedback moves from the user bubble to the assistant reply area.
  Sending, waiting for a step, continuation, actual reasoning, stopping and failure
  are visible before assistant text. Failures retain retry. These are presentation
  states, not fabricated persisted assistant messages; real output replaces them.
  Remote guidance retry also clears the matching sent draft, while preserving
  text edited during the request.

## Validation boundary

Regression coverage uses controlled providers, isolated MCP fixtures, simulated
memory samples and offscreen UI rendering. No user video job or memory-exhaustion
workload was rerun. Historical worker exits cannot be retroactively attributed to
one memory threshold; the new diagnostics are intended to make the next actual
failure attributable.

Passed checks: frontend TypeScript, runtime/package builds and the desktop
production build; MCP scheduling/recovery and live-catalog tests; immediate
guidance and discovery regressions; resource admission/RPC diagnostics; bounded
native MCP exit fixtures; local guidance rendering in both themes; and the focused
remote `--guidance` UI case (retry, ordering and replay). The larger Agents UI
scenario also reaches an unrelated outdated model-settings fixture expectation
for `authentication`/`reasoningEffort`; this review does not claim that full suite
passes. The earlier resource fixture run passed its assertions but hit a Windows
temporary-file cleanup lock; the focused admission rerun passed. A subsequent
cleanup of that leftover test directory was blocked by automatic approval policy.

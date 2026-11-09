# Conversation events

Register a one-time follow-up with `assistant_event` action `create`, a self-contained `text` and offset timestamp `at`. Use `subscribe` with a stable `topic` and a calendar `recurrence` for ongoing work. Ordinary conversations also support `session_hook` for Stop, PostToolUse or PostToolUseFailure. Timed runs retain the source model, project, tools and permissions. Assistant proactive events use their own context and verified delivery route.

Home → Events shows current events, previous plans and their execution history. In Profile → Proactive events, select an event to manage it. Existing IDs, read state, run history and plugin wakeups remain in their original stores. The runtime must be running to execute events.


## Calendar component

Open Home → Events → Calendar. Cells show dates and schedule dots. Hovering for 180 ms reveals holidays, lunar dates, imports and automations; focus/click opens immediately, click pins it, and Escape closes/restores focus.

Detail cards are limited to 300 CSS px in each dimension and available viewport space. The date header stays fixed while contents scroll. The 120 ms transition respects reduced motion. Hovering reads existing snapshots, with no extra request or task execution.

Calendar settings provide holiday switches and JSON/ICS import. Chinese lunar/holiday and US calendars are independently opt-in, cannot be deleted/overwritten by imports, and cover 2020–2050. The Chinese calendar excludes annual adjusted workdays. See [bundled calendar sources](../assets/calendars/README.md).

Calendar data is display-only: it creates no tasks and enters no model context. Storage is `calendars/calendars.json` in user data. Reimporting the same ID replaces data but retains enabled state; errors preserve old data. A memory-limited Worker parses with a 5-second timeout and 8 MiB per-file limit. Limits: 30 imported datasets, 50,000 imported entries total, 16 MiB storage. Details initially show 30 entries per category; More adds 50. See the [calendar protocol](../assets/skills/cardbush-docs/references/calendar-protocol.md).

Schedules derive directly from scheduler snapshots. Only enabled jobs with `nextRunAt` project future runs; frequent runs collapse into ranges/counts. Missed executions are not invented. History groups by queued date. Paused jobs retain history without future dates; event jobs show only actual executions. Task dates use local time; JSON preserves declared civil dates/timezones, while timed ICS events convert to device timezone at import.

`npm run test:calendar` covers projections, cross-day events, import Workers, persistence, lunar/holiday boundaries and plan management. Component tests cover hover delay, bounds/scrolling, reduced motion, settings and narrow windows at 125% scaling.


## Native Hook activation

Reviewed/trusted command, MCP Tool or HTTP Hooks may return successful structured output containing:

```json
{
  "cardbush": {
    "activateAgent": {
      "prompt": "Check the exported files, report results and continue the user's task."
    }
  }
}
```

Commands use stdout JSON; MCP uses `structuredContent` or JSON-parsable text. It can coexist with other Hook fields. Prompts are limited to 32,000 characters and bound to the current conversation. If a Turn is active, activation queues, then starts another Runtime Turn; it is not converted to a Skill.

This is a **CardBush activation extension**, distinct from Claude `type: prompt`/`type: agent` evaluators. Those evaluate events in separate model tasks; the agent evaluator exposes only file reads/search. OpenAI-origin prompt/agent Hooks remain skipped according to their specification. See [plugin compatibility](PLUGIN_COMPATIBILITY.en.md) for execution, permission and timeout boundaries.

Activation records the plugin ID, Hook ID and reviewed definition hash, rechecking enabled/trusted/unchanged state before execution. One Hook reuses a job/history in one conversation. Pausing suppresses further activation until enabled. User edits convert a plugin activation job into an ordinary manual automation; subsequent plugin activation may create a separate job.

## Execution and recovery

- At creation/explicit save, scheduled jobs capture model, tools, generation options, workspace and permissions. They execute from their own configuration without source chat history; prompts must be self-contained. Deleting the source does not cancel scheduled jobs/results. Editing can retain saved configuration if the source is gone. Event/plugin jobs still depend on their source; deletion pauses/cancels pending activation.
- Temporary executions stay out of Recents by default; results appear in Home → Events → Execution history. Expand a history entry to read its saved output in place, even if the source has been deleted. Viewing it does not open an execution tab or add the execution to Recents. Session deletion shows confirmation and its effects.
- Product Host resolves model connections before execution. Job files contain no API keys, and public lists omit system prompts/execution configuration. Old-job migration affects future runs without rewriting history/prompts or reenabling manually paused jobs. Missing configuration fails explicitly.
- Automatic execution preserves source tool order while checking current definitions/availability. Trigger facts enter as a new message with recorded IDs/times, not a fixed-prefix edit. Read-state changes append observations without rewriting messages. Saved parameters share model generation-option definitions. See [request continuity](AUTOMATION_INBOX.md#request-continuity).
- No permission elevation: approval uses existing interaction. Removed models/revoked trust pause the job with a reason.
- Each execution session is serial; global concurrency is three jobs. Independent scheduled work need not wait for the source session but still uses Runtime admission controls. Foreground input preempting the execution session requeues automatic work. Tool events wait for the original Turn to release the session. Completion events reflect true completion, not failure or an intermediate Stop attempt.
- Duplicate events are deduplicated; cooldown/queued/running duplicates coalesce. Events from automated executions and child Agents do not recursively trigger automation or plugin activation.
- The app must be running. No OS schedule is installed and closed apps are not awakened. Sleep/closed-period misses coalesce into one run on recovery. Interrupted executions with unconfirmed outcomes pause and retain records instead of replaying side effects.
- Atomic storage: `runtime-state/scheduler/automations.json`. Corruption reports an error without overwriting the original. Maximum 500 jobs, latest 50 acknowledged runs per job plus unread results. Old `scheduler/jobs.json` placeholders are not automatically activated/migrated.
- Conversation hooks use Stop, PostToolUse and PostToolUseFailure. Assistant subscriptions also support their registered runtime and collector conditions.

`npm run test:automations` covers scheduling, contention, deduplication, stop/interruption, Hook activation, real Electron restart/model restoration, source history and narrow management UI. Tests use isolated directories and local model mocks, not real accounts.

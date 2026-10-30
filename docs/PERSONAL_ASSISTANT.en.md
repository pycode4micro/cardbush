# Personal assistant

[English](PERSONAL_ASSISTANT.en.md) · [简体中文](PERSONAL_ASSISTANT.md)

[中文](PERSONAL_ASSISTANT.en.md) | [Documentation](README.md)

The lightbulb below New conversation opens a persistent conversation, initially named `assistant`. It handles conversation, published material and delegation; background tasks use the existing Agent's model, tools and permissions. This guide describes main-branch behavior, which may be newer than installed desktop packages.

## Getting started

1. Configure a text model in Settings → Models, then open the lightbulb. Text conversation needs no realtime voice service.
2. Assistant settings in the title bar change name, role, communication style or avatar. PNG/JPG/WebP avatars up to 8 MB stay local; restore the default bulb at any time. Role changes affect subsequent text requests and the next call; an active call retains its initial persona.
3. Execution defaults to Local. Connect a deployed service through Connect SSH / Manage hosts following [Agent services](AGENT_SERVICES.en.md), then select it as execution host. Saving an SSH project alone does not create an independent Agent service.
4. Model selection, attachments, drag/drop, pasted images and browser references reuse the ordinary composer. See [Realtime voice](REALTIME_VOICE.en.md) and [Local voice](LOCAL_VOICE_MODELS.en.md).

The assistant reuses the conversation title bar, Inspector, work summary and return-to-bottom control. Compact input retains saved width, post-send position and output direction; returning from Inspector input preserves drafts/attachments. The bulb reflects connection, listening, speech, mute, background execution and errors, respecting reduced motion.

Browser `@` references display clickable tab titles in the composer, sent messages and floating conversation, retaining tab identity rather than encoded long URLs. Existing messages use the same presentation. Floating reply bubbles have distinct backgrounds/borders in both themes.

While awaiting text, the stream/floating view shows a three-dot bubble; completion/failure/stop removes it. Stop waiting stops this response, not independent tasks. Empty/truncated/network-failed replies show an error; Retry reply uses current model configuration while retaining the original message and completed tool receipts, without duplicating user input. Unfinished input after restart also offers retry.

Text generation inherits the model's output limit, default 128,000 tokens including reasoning. No model events for 120 seconds means stalled transport and uses the shared three-attempt budget; reasoning/output refresh the timer. Late stopped responses cannot write into the page or a new context.

With default bottom input, short replies scroll fully into view; long replies start at the beginning while retaining a short current question where possible. Multiple publications in a Turn keep the initial reading position. Manual upward scrolling pauses following; return-to-bottom reveals the end, and a new send restores positioning.

## Page content and tasks

Right-click a text message to reply, quote or copy; select text first to quote or copy just that selection. Quotes appear separately above the composer, link back to the original message after sending, and survive send retries. Quick and additional emoji reactions can be added, replaced or removed and are saved with the local conversation. Reactions never invoke the model or become chat messages. Reset clears the quoted history and reactions. Use Shift+F10 to open the menu, arrow keys to navigate and Esc to close it.

| Content/action | Behavior |
| --- | --- |
| Text messages, dictation after the user sends it | Visible and included in ongoing context. |
| Final text reply | Visible prose without expanded reasoning, tool arguments or loop internals. |
| `page_write` | Publish Markdown into this conversation for reference material, examples, links/results; no external website is created. |
| Call transcripts | Retained internally without per-utterance bubbles, animations or scrolling. Ordinary conversations still display their own call transcripts. |
| Background-task bubble | Intent and actual status; opens the original child execution, remaining available afterward. |

Delegation returns a task ID immediately so conversation can continue. Acceptance is not completion; actual task states determine completed/failed/stopped. Follow-up work stays in the same child conversation, including continuation after completion. Results arrive asynchronously.

Local children inherit the assistant's authorized CardBush tabs/browser selection and can use referenced pages. Adding new references when guiding/continuing a task updates its selection; absent new references, the child's selection remains. Closed/restarted tabs report stale references only when operated on, without blocking unrelated delegation or switching to Chrome/Edge. Remote children do not inherit local tab authorization.

The assistant uses `subagent`, `tasks`, Team and `page_write` to delegate, continue work, read results and publish replies. `subagent({prompt})` creates work; `subagent({task_id,prompt})` guides a running task or continues its original session/host. Realtime voice retains its shared protocol definitions for delegation, immediate status, paged results and page publication. Execution tools remain on the child under its permissions. Voice adds no dispatch confirmation but spoken consent cannot enable disabled tools or override host policy.

Text conversations and the transcription–Agent–speech path also provide direct management tools without starting a child:

- `schedule_task` creates, reads, edits, pauses, resumes, deletes, runs or stops this assistant's schedules using the existing Automations page and scheduler. Saved jobs retain the full model, workspace, execution tools and permission settings. Timed work runs in an isolated conversation without chat history, so prompts must be self-contained. Saving a job does not mean it has executed; CardBush must be running for scheduled execution.
- `scheduled_results` pages through the scheduled-results inbox or reads specific runs. Reading neither marks results read nor reruns work.
- `search_skills`, `list_plugin_commands` and `mcp_search` discover the current Runtime's capabilities, respecting tool settings, Skill scopes and plugin visibility. Discovery neither executes a plugin nor grants permission, and local results do not establish remote worker capabilities.
- `update_task_plan` maintains the parent's overall plan in Work summary, with persistence across refresh and restart. Child progress remains separate. Explicitly resetting the assistant clears the plan but preserves saved schedules.

These tools use the existing argument validation, host permission checks and plugin hooks and retain execution receipts. Permission requests needing human input appear above the composer with allow-once, allow-session, deny and cancel choices. Disabled tools remain disabled; terminal, file writes and generic plugin execution remain delegated.

Transient connection, rate-limit or recoverable service failures allow at most three attempts per model round, using shared backoff (normally 1 and 2 seconds, respecting Retry-After). UI shows/clears retry state appropriately. Attempts preserve context/receipts without redispatching successful actions. Reset/exit cancels waiting. Realtime connectivity has a separate reconnection mechanism.

## Hosts and attachments

Assistant conversation, model and history remain on the local host. There is no standalone Agents chat or execution-host selector. Register remote services as subagents in Team, then let the assistant assemble them through existing subagent/Team tools. Follow-ups keep the original service identity and role. See the [remote interaction protocol](SUBAGENT_REMOTE_PROTOCOL.md).

Attachments retain local preview references. A remote worker needs an explicit transfer or a resource already available on its server. Parent history is not copied automatically, and local paths are not server paths. Vision input follows the selected model and vision settings.

Browser references provide context, not page authorization. Remote graphics require an explicitly deployed [optional Linux desktop](../deploy/agent/README.en.md), without access to the user's local desktop.

## Calls and mute

The dedicated microphone remains in place even with draft text. Click to start dictation: a cue sounds and the icon turns blue. Click again to stop and insert recognized text into the draft. Hold the main send/action button for a call; a simple line waveform fills the bottom and the main button becomes Stop call. Calls use the mode saved in Settings → Voice. Realtime and transcription + Agent + speech have distinct settings; local ASR/TTS do not control the realtime provider's voice or end-of-speech detection.

Returning to text, navigation, settings, minimize and tray hiding retain the call and its owner. The owner page uses composer controls; other pages use the floating capsule. Limited recovery handles transient disconnections; unrecognized audio may need repeating. See [call recovery](REALTIME_VOICE.en.md#context-and-background-compaction).

Right-click the assistant sidebar entry to independently mute microphone or playback; settings persist. Microphone mute stops uploads. Playback mute changes local volume only, allowing replies/tasks to continue. Ordinary calls do not inherit these assistant settings. Hangup releases audio without cancelling dispatched work.

The desktop must remain running to listen. Local tasks follow Runtime stop/recovery; independent services continue accepted remote work while those services run.

## Context and reset

Page messages, internal transcripts and results use a separate JSONL journal without consuming ordinary active-Turn sequence numbers. The text model compacts long context while preserving originals. Realtime also has system-encrypted `voice-history` and background compaction for future calls in the same session. Raw call audio is not archived.

A host-writable `.model.jsonl` journal preserves actual assistant/tool/receipt/reasoning/provider-replay order. Future requests and restart append input instead of reconstructing context from UI bubbles and discarding tool exchanges. `page_write` projections are not duplicated in context, and internal exchanges do not appear on the page or as speech. Legacy migration cannot recover exchanges never saved. Interrupted calls without saved receipts are marked outcome unknown and are not automatically replayed.

Assistant compaction uses the ordinary token budget, including `contextWindowTokens`, tools, reasoning and receipts, rather than a fixed 20,000-character threshold. Only complete exchanges in a prefix are replaced; originals remain and checkpoints survive restart. User model/vision/persona changes and real compaction may change provider prefixes; no cache-hit percentage is guaranteed.

This memory is distinct from cross-session `summary_for_user` habits and next-step prediction. Opening assistant does not enable personalization. Model compaction and spoken task summaries consume text-model usage. Reset clears both page and model journals.

Right-click → Reset context requires confirmation, ends the assistant call, and irreversibly clears page messages, internal transcripts, summaries and encrypted voice memory. Name, avatar, persona, execution host and mute settings remain. Late old requests/calls cannot enter the new context. Other conversations and dispatched child tasks remain; old task bubbles do not reappear. Stop those tasks from their execution details if required.

## Implementation and checks

- `src/features/assistant`: entry/settings/page/shared composer/host choice.
- `packages/bush-runtime/src/assistantConversation.ts`, `conversationJournal.ts`, `assistantModelHistory.ts`: conversation, journals, limited tools and completion feedback.
- `src/backend/realtimeAgent.ts`, `packages/bush-runtime/src/realtimeAgent.ts`: shared request preparation, child dispatch and ownership.
- `electron/realtimeVoiceService.ts`, `src/features/voice`: calls, audio, recovery and maintenance.

Run `npm run test:assistant`, `npm run test:voice-realtime`, and `npm run test:voice` for dictation/legacy calls. Mock Providers, loopback services and isolated windows verify persistence, idempotency, ownership, attachments, reset, background calls and compaction, not real-provider audio quality or live SSH networking. See [architecture](ARCHITECTURE.en.md).

# Realtime voice calls

[English](REALTIME_VOICE.en.md) · [简体中文](REALTIME_VOICE.md)

[中文](REALTIME_VOICE.md) | [Documentation](README.md)

Calls default to a dedicated realtime voice Provider: a built-in Volcengine Doubao adapter or a `cardbush.realtime.v1` compatible service. Ordinary voice models use two limited tools, `subagent` and `tasks`, to collaborate with configured local CardBush child Agents. The [personal assistant](PERSONAL_ASSISTANT.en.md) additionally publishes page content and can delegate to connected standalone Agent services. Execution can use API, SIWC or another configured model; local model weights are not required. Main-branch behavior may be newer than published desktop packages.

## Setup and controls

1. Open Settings → Voice → Voice calls and select Realtime voice (default).
2. Enable full-duplex realtime speech in the [Doubao speech console](https://console.volcengine.com/speech). Create a speech-service key following the [official API-key guide](https://docs.volcengine.com/docs/DoubaoVoice/APIKeyUsage?lang=zh), not an Ark text-model key or old binary-protocol AppID/access-token configuration.
3. Save the API key, model ID, call instructions and female/male voices. For the same provider/address, a blank key preserves the old value; deletion is explicit. System secure storage encrypts credentials, and settings APIs never return them. Each provider retains its own configuration. Changes affect the next call; an active call keeps its original binding.
4. The dedicated microphone remains in the composer and only handles dictation. Click for an audible cue and blue icon; click again to stop and insert text into the draft, without sending or steering running work. Hold the main send/action button for about 500 ms to call. A simple line waveform expands left-to-right across the footer; the main button becomes Stop call. A normal main-button click still sends. Settings remain in the settings page, replacing the old call-settings popup. Away from the owner page, a floating capsule retains controls.
5. Live audio goes to the selected service, with bounded context from recent completed text exchanges. Calls use the app's model proxy route. Missing configuration fails explicitly without another cloud-provider fallback.

For an existing compatible service, select CardBush Realtime and configure its WebSocket URL, model, voices and key. Loopback permits `ws://`; remote uses `wss://`. Changing address clears the old key. Although the protocol permits keyless local services, the [current desktop entry](../src/features/voice/voiceSession.ts) still requires a saved key. The service must implement [Realtime v1](../assets/skills/cardbush-docs/references/realtime-protocol.md), not an arbitrary vendor endpoint. Different protocols require an adapter/bridge; see the [provider guide](../assets/skills/cardbush-docs/references/realtime-provider.md).

Default voices are Vivi (`zh_female_vv_jupiter_bigtts`) and Yunzhou (`zh_male_yunzhou_jupiter_bigtts`), at normal speed. Other supported [official voice IDs](https://docs.volcengine.com/docs/6561/1257544?lang=zh) can be entered. Instructions influence conversation style; emotion, recognition and latency still require listening tests on the actual account/device/network.

Casual conversation does not create an execution task. For requested work, the voice model briefly states intent and calls `subagent` without an extra voice confirmation. Runtime prepares the same model, instructions, directory, tools and permissions as text execution and creates a real child session. Dispatch returns immediately even while the parent is working, within Runtime's eight-background-task limit.

| Tool | Behavior |
| --- | --- |
| `subagent({prompt,task_id?})` | New task without an ID; guide a running task or continue the original child/host with an ID. Returns running/message_queued immediately. Include relevant spoken context. |
| `tasks({action:"inspect",task_ids?})` | Immediate snapshot and asynchronous notification registration; no blocking speech or repeated polling. Omitted IDs select this conversation's voice tasks. |
| `tasks({action:"conversation",task_ids:[task_id],cursor?})` | Page one child's exchanges/final reply, excluding private reasoning/tool logs. |

App-level ownership keeps microphone/playback alive through session switches, settings, minimize and tray hiding. Later speech/tasks stay with the original owner. Composer controls appear on that page; the floating capsule appears elsewhere, avoiding duplicates. Calls prevent idle sleep, not explicit quit/sleep/shutdown. Results are attributed/deduplicated by task ID, and acceptance is not completion. Hangup removes voice observation without cancelling tasks; actual app exit follows Runtime stop/recovery semantics.

Dictation belongs to the visible session. Hidden assistant refreshes cannot take it over. Leaving its page releases the microphone and cancels undelivered transcription, preventing late text from entering another draft. Held-button calls retain app-wide ownership instead.

Ordinary calls append final user transcripts and model replies to their original conversation, independently of active text-Turn numbering. Message IDs deduplicate retries. Later text can reference the call. Raw audio is not archived; deleting/clearing the conversation removes its transcripts.

## Assistant calls

The sidebar lightbulb opens the personal assistant. Only this entry uses its customizable persona; see [assistant settings and reset](PERSONAL_ASSISTANT.en.md).

- It shares app-level audio ownership. Microphone and playback mute are independent/persistent; playback mute changes local volume without cancelling replies/tasks.
- Call transcripts remain internal. The page shows text messages, published Markdown and clickable task bubbles. `page_write({content})` writes to this conversation, not an external site. Ordinary conversations still show transcripts.
- New tasks default to local execution or a selected connected Agent, including supported SSH connections. Follow-ups/read/continue retain the original host. The parent uses `subagent`, `tasks` and `page_write`; execution tools remain with children.
- Confirmed reset ends the assistant call and clears visible/internal context and encrypted voice history. Dispatched work remains in child sessions; late old receipts cannot enter the new context.

## Task results and speech

Task completion writes clearly marked application data into the voice context during a speech gap, with a bounded availability notice in the model instructions. It does not generate a separate summary, call `speech_text_buffer.commit`, manufacture a user utterance or reuse a settled tool `call_id`. Full results remain in the child session.

On its next natural reply, the voice model is instructed to say that the material is available and ask whether to revisit the earlier question. It discusses findings after the user agrees or asks about them; failures and stopped tasks remain distinct from completed results. The current [Seeduplex protocol](https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh) has no independent model-response trigger, so receiving a background result alone does not force a new spoken turn. This notification path consumes no extra text-model summary request.

Assistant captions follow the local Web Audio playback clock, not incoming text generation. Text received ahead of audio stays buffered. Final conversation entries are saved after playback; interruption retains only the revealed prefix. Seeduplex does not provide word timestamps, so progress is estimated from the received audio duration and text length rather than exact word alignment.

Fixed behavior instructions accompany the user persona: dispatch directly, keep talking, reuse task IDs, report actual status, avoid duplicate notifications and treat child content as data. Actual compliance still requires real-call acceptance.

Execution retains Agent permissions; full access adds no routine-tool confirmation. Dispatch errors are visible with details/codes while the call continues. Disabled tools, missing execution models, old Runtime versions or connection failures cannot be fixed by verbal approval, and the model should not invent a permission diagnosis without attempting a tool. Restart CardBush after updating code to load new Runtime/instructions.

## Relationship to other voice modes

- Transcription + Agent + speech remains available with SenseVoice, Qwen3-TTS, custom TTS and pause merging. These settings do not control realtime voices/end-of-speech detection.
- Realtime streams audio directly, without local speaker filtering/buffering for verification. Disable speaker lock before realtime calls; it remains available for dictation and the transcription-based call mode.
- Microphone mute sends the service control and stops uploads; unmute resumes. Recognized speech-start immediately clears local playback and sends `response.cancel`; late chunks/text from that reply cannot resume it. A late cancellation acknowledgment cannot stop a newer reply. Raw microphone level and failed/noise-only transcripts do not interrupt speech.
- Hangup, window destruction or fatal errors release audio. Navigation/minimize retain calls. Hangup does not cancel accepted Agent work; results stay with the owner.
- When the model calls `hang_up`, the app acknowledges the tool, waits for the farewell audio to finish arriving and the local playback queue to drain, then closes while retaining the reply text. An older reply's end event cannot prematurely close the call. The 15-second fallback only applies when no output is arriving and no audio remains queued; it never cuts off ongoing playback. Clicking Stop still hangs up immediately.
- Ordered microphone buffering allows up to five seconds and four concurrent IPC transfers. Mute/hangup drops unsent frames. Playback can buffer two minutes of generated audio rather than failing after ten seconds; manual interruption immediately clears it.
- Rotated `realtime-voice.log` distinguishes context compaction/fallback/restart from transport loss, recording safe reason codes, socket close codes, capacity estimates and buffer counts. It never records audio, transcripts, prompts, raw provider close reasons or credentials.
- After connection, network loss, send congestion and context-handoff timeout allow at most three recovery attempts. UI shows restoring while retaining ownership, mute and tasks. Explicit hangup or authorization/protocol errors do not retry indefinitely. Exhaustion offers reconnection with saved context intact.
- Calls belong to local conversations; assistant execution may route to SSH/cloud hosts. Unavailable system encryption prevents key storage; there is no plaintext fallback.

## Context and background compaction

The app estimates pressure from instructions, tools, text and receipts using UTF-8 bytes divided by two. Seeduplex documents a 64K-token window; its adapter starts maintenance at 48,000 estimated tokens and limits combined restore input to 96,000 bytes, leaving room for provider internals, audio and new exchanges. Its 40-message limit applies to each import request, not the whole history: longer histories restore in acknowledged batches before capture resumes. The compatible bridge retains its conservative 6,000-token / 16,000-byte defaults unless its adapter specifies a different policy. These estimates are not the provider's exact remaining capacity.

Maintenance uses the conversation's text model and existing Provider adapters in a separate request. It reuses `ContextCompactionTransaction` and `checkpoint_context` source binding/validation/correction. Only that request sees `checkpoint_context`; the realtime model retains its limited tools. Maintenance is outside the main execution Turn, runs no business tools, changes no personalization settings and consumes text-model usage.

Each maintenance transaction freezes its old-history range and summary revision, normally retaining two recent exchanges. Large exchanges may move more completed history into the summary to meet reconnect capacity. Summaries are limited to 2,000 characters and may tighten further for actual prompts/recent history. Audio/tasks continue. New exchanges remain outside the snapshot; excessive new content triggers another snapshot rather than silent deletion. Model requests have a 60-second limit, three format-correction attempts and failure backoff; originals remain.

Remote maintenance waits for user speech, service response, local playback and pending tool batches to finish: query the specific saved old item IDs → verify actual identities and complete QA → write/confirm summary → delete/confirm covered QA. It does not depend on the provider's default recent-history retrieval window. Notification IDs are bound only from a verified creation receipt. Matching text alone is not an item identity; response IDs are not context IDs. Full originals and validated summaries are saved locally before remote deletion.

Unsupported operations, missing acknowledgments or old items outside the query range cause a new connection from summary/recent exchanges. Network recovery uses the same process: read local memory, compact if necessary, connect with muted keepalive, add complete QA and verify receipts. A service may regenerate `event_id` or item IDs, but the current connection batch, complete ordered roles/text and unique item IDs must match; actual server IDs are saved. Failure to echo client IDs alone is not a timeout. Manual reconnection uses this process too, without silently dropping old exchanges.

Late task results are retained as history and restored after disconnect. Old tool calls are not replayed or redispatched into a new connection. Deduplication, observers and session ownership persist; old connection events cannot mutate the new one.

Handoff buffers at most five seconds of audio, then pauses capture with a notice instead of ending the call. After history confirmation, intact buffered audio drains at 20 ms intervals while new capture pauses. Overflow discards the incomplete buffer and asks the user to repeat the interrupted sentence. Unrecognized audio cannot be claimed as restored text. Handshake/history confirmation waits at most 20 seconds each, with backoff; failure preserves originals.

`voice-history` in user data uses hashed session names and system encryption. It retains text, not raw audio; summary updates do not delete local original text. Session deletion/clear removes corresponding voice history. It supports later calls in that session, not an automatic cross-session profile. State/log diagnostics distinguish preparing history, connecting, creating session, restoring history and ready.

## Implementation and verification

`electron/realtimeVoiceProvider.ts` defines normalized sessions/audio/control/tool replies; `realtimeVoiceMessages.ts` defines JSON messages. `volcengineRealtimeVoice.ts` and `cardbushRealtimeVoice.ts` implement adapters, including frame/ack translation. Registration/configuration/encryption are separate from tool plugins; vendors do not replace the Agent loop. Bundled `cardbush-docs` holds deployment, voice, adapter and protocol references.

`realtimeVoiceService.ts` owns credentials, sockets, ownership, deduplication, idle-gap context delivery and lifecycle. Renderer `realtimeVoiceAudio.ts`/AudioWorklet capture 16 kHz PCM16 mono (20 ms / 640 bytes) and play 24 kHz PCM16; `realtimeVoiceCaptions.ts` uses actual playback progress for text updates. `src/features/voice/realtimeAgentBridge.ts` returns immediate receipts and observes tasks; Runtime `RealtimeAgentDispatcher` owns real dispatch, ownership and parent/child messages. Initial context preserves full QA within the combined prompt/tool/history budget.

Protocol references: [full-duplex API](https://docs.volcengine.com/docs/DoubaoVoice/endtoend-realtime-voice-full-duplex-version?lang=zh), [integration requirements](https://docs.volcengine.com/docs/DoubaoVoice/access-mustread?lang=zh). The adapter defaults to model `1.2.6.1` at `/api/v3/duplex/realtime/dialogue`; other IDs must support the same protocol.

`npm run test:voice-realtime` checks protocol, ownership, deduplication, background concurrency/guidance/resume, notifications/backpressure, plus isolated Electron AudioWorklet/preload/loopback/playback/mute/navigation. Compaction cases include frozen ranges, late results, format errors/cancellation, encrypted restore, acknowledge-before-delete, deferred playback maintenance and handoff audio. Runtime uses mock models with real dispatch/compaction; UI uses synthetic audio/temporary configuration, no live credentials/Volcengine/external tasks. `npm run test:voice` covers legacy voice; `npm run test:assistant` adds pages/attachments/reset/remote ownership.

These checks do not verify a real account's activation, billing, latency, accent recognition or listening quality. Test an actual call after configuring the service.

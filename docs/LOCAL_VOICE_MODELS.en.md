# Optional local voice

[English](LOCAL_VOICE_MODELS.en.md) · [简体中文](LOCAL_VOICE_MODELS.md)

[中文](LOCAL_VOICE_MODELS.en.md) | [Documentation](README.md)

This guide covers dictation and transcription + Agent + speech calls. Default [realtime calls](REALTIME_VOICE.en.md) have a separate Provider configuration and do not depend on local ASR/TTS. See [assistant](PERSONAL_ASSISTANT.en.md) for continuous conversation, task bubbles and host selection. Dated experiments remain in the [original Chinese record](LOCAL_VOICE_MODELS.en.md); their old controls are not current UI instructions.

## SenseVoice recognition

SenseVoice Small is the optional Chinese/English offline recognizer. It is not preinstalled or downloaded automatically at startup, in settings or when recording. Fresh Windows installs retain system dictation; existing choices are preserved. Installation and selection are separate.

1. Settings → Voice → SenseVoice Small → Download and install. Windows x64 download is about 187 MB, installed size about 260 MB.
2. Inspect upstream sources/license; cancel downloads if needed. Failed integrity checks reject files.
3. Select the installed model and Save. Language can be auto, Chinese or English; use auto for mixed speech. Keep original words is the default to avoid ITN number/punctuation normalization damaging English. Automatic normalization remains explicit.
4. Select a microphone or use the system default. A disconnected explicitly selected device errors rather than silently switching.
5. ASR and playback are independent: SenseVoice plus Windows voices needs no API key. The dedicated microphone starts/stops dictation and inserts text into the draft; the user sends normally. Only calls automatically speak Agent replies.
6. Select/save another recognizer before uninstalling. Uninstall does not affect history or Windows speech components.

Missing models or inference failures never automatically install a model, switch to cloud or upload audio. Download uses Settings → Network proxy → Marketplace and plugins, normally following the app proxy with system/custom overrides. Redirects are checked at every hop. Do not disable TLS/integrity checks or use unverified mirrors. Cloud speech uses the default app route separately.

Sources: [SenseVoice/FunAudioLLM](https://github.com/QwenAudio/SenseVoice), [official sherpa-onnx conversion](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html), package `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`, [sherpa-onnx v1.13.8](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8). CPU inference needs no Python/CUDA/service. The model uses [FunASR MODEL_LICENSE](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE), not the code's MIT license; model, sherpa Apache-2.0, ONNX Runtime MIT and source notices are retained. The newer 2025-09-09 conversion targets Cantonese fine-tuning and was not substituted merely for its date; local Mandarin/English checks found language confusion.

## Installation and execution boundaries

- Only the main app window can install. Downloads use fixed HTTPS GitHub releases and allowed official redirect domains.
- `electron/voiceModelManifest.ts` pins versions, archive sizes/SHA-256, and separately verifies extracted model, vocabulary, executable and library files.
- Extraction allows only fixed entries in managed directories, without install scripts, package managers or administrator requests. A staged install switches only on success; failure/cancellation removes staging.
- Models live under Electron `userData/voice-models/`, outside source/install/system directories. Development downloads are not bundled.
- First inference and file-stat changes recheck contents. Corruption blocks execution; active recognition/synthesis blocks uninstall.
- Desktop converts recordings to mono PCM WAV. SenseVoice needs a temporary WAV, removed on normal completion/failure/cancellation without transcription logs. Forced app/OS termination can leave temporary files: audio is not strictly memory-only.
- Recordings are capped near two minutes; longer audio splits at low-energy points into ordered segments of at most 25 seconds. CPU inference is serial, bounded and cancellable.
- Windows x64 has native validation. Linux x64 has an upstream runtime adapter but the recorded work did not include Linux-machine regression. Windows local speech synthesis is not available on Linux.

The October 3 public-sample results are [historical observations](LOCAL_VOICE_MODELS.md#开发机实测2026-10-03), not accuracy or latency guarantees. Each request loads its model; mixed-language errors, noise and specialist vocabulary still need evaluation. No user's microphone was recorded for those checks.

## Verification and upgrades

- `npm run test:voice`: state, credential protection, voices, recognition, install failure/cancellation/tampering, segmentation and Electron UI; no normal model download.
- `npm run test:voice-model-native`: existing model/public samples, Windows comparison, cancellation/audio cleanup; skips missing prerequisites. Ignored report: `tmp/voice-sensevoice-benchmark.json`.
- `node scripts/test-voice-model-native.mjs --install-dev`: explicit developer-machine installation after compiling Electron sources; run only with authorization. It does not change recognition preferences.
- `node scripts/test-voice-ui.cjs --local-model`: official archives already in `tmp/sensevoice-upstream/`, real verified installation into an isolated directory, selection/save/IPC/uninstall checks, without touching the user's models.

Upgrades require checking source, archive/internal hashes, licenses and language quality; no unchecked dynamic latest download.

## Local playback choices

Qwen3-TTS is the primary optional local playback choice. Select Qwen3-TTS in Settings → Voice → Agent voice, choose an official CustomVoice model directory and a Python environment with dependencies, then Save and preview. It needs no cloud speech/key. Fresh installs without setup continue using Windows system voices. Existing users are not switched to missing weights. Store/development builds may use different data directories and need their own directory selection.

Default voices are Serena and Uncle Fu. The 1.7B model accepts an editable tone instruction; the natural rate is 1× without accelerated playback. Tone instructions do not guarantee a particular sound. Choosing Qwen changes neither ASR, speaker lock nor cloud credentials. Missing directories/dependencies or failed inference report errors without fallback to Kokoro/cloud.

### Existing custom model directories

Choose Custom local model, inspect the directory type/voices, assign female/male choices and Save and preview. Ordinary text chat still does not auto-speak. Supported formats:

| Format | Required files | Runtime |
| --- | --- | --- |
| Qwen3-TTS 12Hz CustomVoice 0.6B / 1.7B | Complete official configuration/tokenizer, `speech_tokenizer/` and safetensors weights, including shards | Explicit Python with `qwen-tts` and PyTorch; nearby `.venv` may be suggested but is not created |
| Kokoro sherpa-onnx Chinese/English | `model.int8.onnx` or `model.onnx`, `voices.bin`, `tokens.txt`, dictionaries, Chinese FST and `espeak-ng-data/` | Explicitly install the existing verified Kokoro component first; Windows x64 currently |

Qwen voices come from model configuration. Assign any of its nine official presets to the two buttons. Tone instructions are available for 1.7B, not 0.6B. Device selection is auto/CPU/NVIDIA CUDA; auto prefers CUDA available in the chosen Python. Qwen uses its natural speed, not other engines' speed controls. Base, VoiceDesign, GGUF and single-weight-file folders are unsupported.

Directory detection checks format/files without executing model code; it does not establish dependency readiness, provenance or inference quality. Save and preview starts synthesis. Follow the [official Qwen setup](https://github.com/QwenLM/Qwen3-TTS), [CustomVoice weights](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) or [Kokoro format](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html) and applicable licenses in an independent environment.

Import saves local paths/settings, without copying/deleting/uploading weights, syncing them to cloud Agents or installing dependencies. Qwen uses offline loading, safetensors and disabled custom Python classes. Stop preview, hangup or UI closure cancels the request; Windows terminates that request's Python descendants. Moved/deleted weights can be reselected in settings.

There is no resident preload/streaming model: each Qwen request loads weights and produces a complete segment before playback. Cold startup may approach a minute. Synthesis allows 180 seconds plus ten seconds of outer cleanup; other engines retain their existing limits. Cancellation remains immediate. This avoids premature timeout and does not promise low latency.

`npm run test:voice` verifies directory/settings/routing/cancellation/voice-list/narrow UI without downloading. `npm run test:voice-custom-native` uses existing Qwen/Python for real PCM/cancellation; set `CARDBUSH_CUSTOM_TTS_MODEL` and `CARDBUSH_CUSTOM_TTS_PYTHON` for other locations. Missing prerequisites skip explicitly; user settings stay unchanged.

### Kokoro compatibility option

Kokoro v1.1 INT8 remains available when selected; its install card is no longer the primary recommendation. Windows x64 download is about 172 MB, installed about 236 MB. It is not automatically installed/selected, and existing models/settings are retained.

- [hexgrad Kokoro v1.1 Chinese model](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh), Apache-2.0; [sherpa conversion](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html) `kokoro-int8-multi-lang-v1_1`, runtime v1.13.8.
- Defaults: sid 3 (`zf_001`) and sid 58 (`zm_009`). Choose among 55 Chinese female and 45 male voices without downloading again; [voice mapping/samples](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html).
- Natural continuity merges only adjacent already-arrived short sentences; sentence-by-sentence remains available. Both use saved speed, default 1×, without an extra 0.94 multiplier. Preview offers statements/questions/encouragement. No emotion prompts, cloning or arbitrary emotional control is supported.
- Settings expose [eSpeak NG source/GPL](https://github.com/espeak-ng/espeak-ng); installed notices retain original licenses.
- The shared installer verifies fixed archives/all file hashes. Dictionary entries stream from extraction stdout into allowlisted paths, not arbitrary paths/links.
- ASR/TTS models, queues, selection and uninstall are independent; no cloud/key is used. Normal success/failure/cancellation cleans synthesis WAVs. Sentence synthesis has CPU delay, not native realtime latency.
- `node scripts/test-voice-kokoro-native.mjs` uses verified `tmp/kokoro-upstream/` for installation/PCM/cancellation/cleanup, otherwise skips without downloading. `node scripts/test-voice-ui.cjs --local-model --speech-model` verifies isolated installation, explicit selection, IPC and uninstall protection.

## Transcription-based call behavior

The following applies to transcription + Agent + speech, not dedicated dictation or realtime-provider end-of-speech detection. Segmentation and submission are separate: about 1.25 seconds of silence may trigger ASR, and a 45-second segment limit only splits audio. Recognized segments merge in order within the utterance. New speech, pending audio or undelivered recognition prevents premature submission. Waiting is measured from recent speech, so slow ASR does not add another full silence interval.

Call pause settings offer normal 3 seconds or patient 6 seconds; while the Agent is executing, wait at least 5 seconds. Completed utterances enter the existing immediate-guidance path, interrupting model generation rather than active tools. Silence/volume/unfinished ASR alone do not interrupt playback or trigger work. A complete independently verified speaker command such as “stop for a moment” can bypass additional delay; a longer sentence containing those words cannot. Without speaker lock, ordinary pause rules apply.

Recognized utterances queue on actual message acceptance, not the entire Agent Turn's completion. Up to three segments queue; capacity pauses capture and resumes after processing. Failed sends retain recognition for retry. Ambiguous filler-only utterances/single letters are ignored without confirmation, while meaningful short commands are not universally filtered. Tool display titles are visual only; only visible assistant prose is spoken, excluding tool payloads/reasoning. Interrupted speech is not replayed.

Noise filtering uses duration, speech frequencies and adaptive thresholds. Only complete valid transcription interrupts playback; empty results, vague fragments, failures and likely echo retain current speech. Repeated text matching playback can be misclassified as echo. Filtering is not speaker authentication. Automatic interruption waits for segmentation/recognition and is slower than a volume trigger; use Stop for immediate control. No extra cloud classifier or prediction integration is involved. Historical “done speaking”/expanded-capsule controls are described in the dated original; current composer controls follow [Realtime voice](REALTIME_VOICE.en.md#setup-and-controls).

## Optional speaker lock (Windows x64)

Off by default and not preinstalled, CAMPPlus reuses verified model downloads/proxy/local CPU execution without Python/GPU/cloud. Weights are about 28 MB, total download about 52 MB and install about 50 MB. ASR/TTS choices remain unchanged.

1. Settings → Voice → Speaker lock → Local model: install CAMPPlus.
2. Add/name up to eight people. Selecting a card only views/manages it; it does not switch the authorized person.
3. Prepare a passage, optionally edit it, then start that recording. Recommended 8–12 seconds; stop early or at 12 seconds. The next segment never starts automatically. Enrollment ends active recording/calls, not Agent tasks.
4. Preview, then explicitly accept the segment for quality/consistency checks and saving. Start each subsequent segment manually. Each person needs 3–8 segments, editable across visits; failed/cancelled replacement preserves old data.
5. Enable lock only after enrollment. Use this person explicitly changes the sole authorized speaker. Strict matching is default; re-enroll in quiet conditions or choose standard if frequently rejected. Speaker changes save immediately.
6. Deleting an unused person preserves current lock. Deleting the active person disables lock without choosing another. Disable before reducing the active profile below three segments or uninstalling the model.

Enrollment audio stays temporarily in memory for preview/extraction and is released after accept/cancel; saved segments have no raw replay. Name, passage, times and embeddings use Windows secure-storage encryption in `userData/voice-speaker-profile.json`. No upload/cloud synchronization or passive learning of bystanders occurs. UI/IPC exposes only switches/current person/mode/profile metadata, not embeddings. Legacy single-person data appears as My voiceprint with settings preserved and upgrades on edit. Corrupt/undecryptable data fails closed; settings permit clearing/re-enrollment.

Verification occurs in the main process **before** local or cloud transcription for dictation/transcription-based calls. Nonmatching/uncertain/missing verification is discarded, never sent to ASR, Agent, retry/confirmation queues, and does not interrupt playback. Changing profiles invalidates late results. Even cloud recognition uploads only locally verified segments. Realtime streaming requires lock off.

Overlapping analysis windows avoid relying on one whole-clip average. Too-short/quiet/distorted audio or model failure is not accepted. About 1.5 seconds of valid speech is needed, so very short commands may be rejected; use UI Stop when necessary. This reduces accidental activation; it does **not** separate overlapping speakers or guarantee protection against bystanders, replay or imitation, and is not authentication for sensitive actions. Microphones, noise, language and voice changes affect results.

Sources: [3D-Speaker/CAMPPlus](https://github.com/modelscope/3D-Speaker), [model card/Apache-2.0](https://modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common), [official sherpa weights](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models). `electron/speakerManifest.ts` pins version, sizes, hashes and notices, with sherpa-onnx v1.13.8. This implementation supports Windows x64.

`npm run test:voice` covers encryption, default-off behavior, window rejection, cancellation, single-active-person policy, segment replacement/deletion, migration/corruption, stale results and no-send/no-interruption for rejected speech. `node scripts/test-voice-ui.cjs --speaker-model` uses verified ignored `tmp/voice-speaker-research/` caches and public audio in isolated Electron data, without touching the user's mic/profiles. Dated real-sample checks are retained in the original guide and are not an accuracy benchmark or evidence for the user's own voice/overlapping speech.

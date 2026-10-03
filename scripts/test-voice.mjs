import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import ts from 'typescript';
import { turnClock } from './voice-turn-fixtures.mjs';
import { VoiceService, validateVoiceSettings } from '../dist-electron/voiceService.js';
import { defaultVoiceSettings as systemVoiceSettings } from '../dist-electron/voiceTypes.js';
const defaultVoiceSettings = { ...systemVoiceSettings, engine: 'cloud', recognitionEngine: 'cloud' };

const compile = file => {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', 'require', source)(exports, spec => compile(resolve(dirname(file), spec + '.ts')));
  return exports;
};
const { SpeechPhrases, SpokenTranscript } = await compile('src/features/voice/speechText.ts');
const { VoiceSession } = await compile('src/features/voice/voiceSession.ts');
const { pcmWave } = await compile('src/features/voice/voiceRecording.ts');
const { VoiceActivity, isVoicePlaybackEcho } = await compile('src/features/voice/voiceActivity.ts');
const pause = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function service(fetcher) {
  const directory = mkdtempSync(resolve('tmp/voice-service-test-'));
  return { file: join(directory, 'config.json'), instance: new VoiceService(join(directory, 'config.json'), {
    fetch: fetcher, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(),
  }) };
}
test('voice credentials are redacted; retained credentials cannot follow a new endpoint', () => {
  const { instance, file } = service(fetch);
  const saved = instance.save({ ...defaultVoiceSettings, apiKey: 'voice-test-secret' });
  assert.equal(saved.hasApiKey, true); assert.equal(saved.apiKey, undefined);
  assert.ok(!readFileSync(file, 'utf8').includes('voice-test-secret'));
  instance.save({ ...saved, voice: 'male' }); assert.equal(instance.settings().voice, 'male');
  assert.throws(() => instance.save({ ...saved, baseUrl: 'https://another.invalid/v1' }), /重新填写/);
  for (const baseUrl of ['http://public.invalid', 'https://user:pass@api.invalid', 'https://api.invalid/?token=x']) assert.throws(() => validateVoiceSettings({ ...saved, baseUrl }));
  instance.save({ ...saved, apiKey: '' }); assert.equal(instance.settings().hasApiKey, false);
});

test('new profiles default to local speech; legacy cloud preferences remain explicit', async () => {
  const { instance, file } = service(() => { throw Error('Local mode must not contact the network'); });
  assert.equal(instance.settings().engine, 'system'); assert.equal(instance.settings().hasApiKey, false);
  await assert.rejects(instance.speak(1, { id: 'local', text: '你好' }, () => {}), /本地语音组件/);
  const legacy = { ...defaultVoiceSettings, secret: Buffer.from('legacy').toString('base64') }; delete legacy.engine; delete legacy.recognitionEngine; delete legacy.recognitionLanguage;
  writeFileSync(file, JSON.stringify(legacy)); assert.equal(instance.settings().engine, 'cloud');
  instance.save({ ...instance.settings(), engine: 'system' }); assert.equal(instance.settings().engine, 'system');
  assert.equal(instance.settings().hasApiKey, true); // Retained cloud credentials never force a cloud fallback.
});

test('PCM WAV encoding preserves rate, clipping and signed samples for Windows dictation', () => {
  const audio = pcmWave(new Float32Array([-2, -.5, 0, .5, 2]), 16000), view = new DataView(audio);
  assert.equal(Buffer.from(audio).subarray(0, 4).toString(), 'RIFF'); assert.equal(view.getUint32(24, true), 16000);
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -16384, 0, 16384, 32767]);
});
test('transcription validates uploads and speech streams before completion with both voice presets', async () => {
  const bodyEnded = deferred(), firstChunk = deferred(); let speech;
  const { instance } = service(async (url, input) => {
    assert.equal(input.redirect, 'error'); assert.equal(input.headers.Authorization, 'Bearer test-key');
    if (url.endsWith('/transcriptions')) {
      assert.equal(input.body.get('model'), 'gpt-transcribe'); assert.equal(input.body.get('file').type, 'audio/webm');
      return Response.json({ text: '  你好，继续。  ' });
    }
    speech = JSON.parse(input.body); assert.equal(speech.response_format, 'pcm');
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(new Uint8Array([1, 0, 2, 0])); await bodyEnded.promise;
      controller.enqueue(new Uint8Array([3, 0])); controller.close();
    } }), { headers: { 'content-type': 'audio/pcm' } });
  });
  instance.save({ ...defaultVoiceSettings, apiKey: 'test-key' });
  assert.deepEqual(await instance.transcribe(1, { id: 'record', audio: new ArrayBuffer(40), mimeType: 'audio/webm;codecs=opus' }), { text: '你好，继续。' });
  await assert.rejects(instance.transcribe(1, { id: 'invalid', audio: new ArrayBuffer(0), mimeType: 'audio/webm' }));
  let completed = false; const chunks = [];
  const running = instance.speak(1, { id: 'speech', text: '你好', voice: 'male' }, value => { chunks.push(value); firstChunk.resolve(); }).then(() => { completed = true; });
  await firstChunk.promise; assert.equal(completed, false); assert.equal(speech.voice, 'onyx'); assert.equal(chunks[0].sampleRate, 24_000);
  bodyEnded.resolve(); await running; assert.equal(chunks.length, 2);
  await instance.speak(1, { id: 'female', text: '你好', voice: 'female' }, () => {}); assert.equal(speech.voice, 'nova');
});
test('provider errors do not echo secrets and cancellation is owner scoped', async () => {
  const auth = service(async () => new Response('secret-key-private-provider-body', { status: 401 })).instance;
  auth.save({ ...defaultVoiceSettings, apiKey: 'key' });
  await assert.rejects(auth.speak(1, { id: 'a', text: '你好' }, () => {}), error => !error.message.includes('secret') && /授权失败/.test(error.message));
  const entered = deferred();
  const blocking = service(async (_url, input) => { entered.resolve(); return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(Error('aborted')))); }).instance;
  blocking.save({ ...defaultVoiceSettings, apiKey: 'key' });
  const job = blocking.speak(1, { id: 'request', text: 'hello' }, () => {}); await entered.promise;
  blocking.cancel(2, 'request'); assert.equal(blocking.jobs.size, 1);
  blocking.cancel(1, 'request'); await assert.rejects(job, error => error.name === 'VoiceCancelledError'); assert.equal(blocking.jobs.size, 0);
});
test('speech phrases preserve sentence order, strip markdown, and suppress split fenced code', () => {
  const phrases = new SpeechPhrases();
  assert.deepEqual(phrases.append('你好'), []);
  assert.deepEqual(phrases.append('。下面是 [报告](https://example.com)。\n```py\nprint("secret")'), ['你好。', '下面是 报告。']);
  assert.deepEqual(phrases.append('\n``'), []);
  assert.deepEqual(phrases.append('`\n完成'), []);
  assert.deepEqual(phrases.append('', true), ['完成']);
  const long = new SpeechPhrases().append('字'.repeat(5000) + '。', true);
  assert.equal(long.join(''), '字'.repeat(5000) + '。'); assert.ok(long.every(phrase => phrase.length <= 240));
  const splitFence = new SpeechPhrases();
  assert.deepEqual(splitFence.append('字'.repeat(239) + '``'), ['字'.repeat(239)]);
  assert.deepEqual(splitFence.append('`py\n不能朗读\n```\n结束。', true), ['结束。']);
});
test('history, internal messages, superseded text and duplicate updates are not spoken', () => {
  const transcript = new SpokenTranscript();
  const history = { id: 'old', role: 'assistant', turnId: 'old-turn', content: '历史。' };
  transcript.reset([history]);
  const current = { id: 'new', role: 'assistant', turnId: 'new-turn', content: '你好。尾句' };
  const messages = [history, current, { id: 'internal', role: 'assistant', content: '秘密。', metadata: { visibility: 'internal' } }];
  assert.deepEqual(transcript.update(messages, 'new-turn', true), ['你好。']);
  assert.deepEqual(transcript.update(messages, 'new-turn', true), []);
  assert.deepEqual(transcript.update(messages, null, false), ['尾句']);
  assert.deepEqual(transcript.update(messages, null, false), []);
  transcript.skip(messages);
  assert.deepEqual(transcript.update([history, { ...current, content: current.content + '已打断。' }], 'new-turn', true), []);
});

function sessionFixture(overrides = {}, playback = {}, clock, captureOverrides = {}) {
  let callbacks; const sent = [], spoken = [], cancelled = [], mutes = []; let stopped = 0, closed = 0;
  const api = { settings: async () => ({ ...defaultVoiceSettings, hasApiKey: true }), saveSettings: async value => value,
    transcribe: async () => ({ text: '请继续', speakerVerified: true }), cancel: async id => { cancelled.push(id); }, ...overrides };
  const session = new VoiceSession(api, {
    clock: clock ?? (() => { let now = 100000; return { now: () => now, later: (callback, ms) => setImmediate(() => { now += ms; callback(); }), cancel: clearImmediate }; })(),
    capture: (_mode, value) => { callbacks = value; return { start: async () => {}, finish: () => { value.clip(new Blob(['audio'], { type: 'audio/webm' })); return true; }, close: () => { closed++; }, mute(value) { mutes.push(value); }, ...captureOverrides }; },
    playback: () => ({ prepare: async () => {}, speak: async (text, voice) => { spoken.push([text, voice]); }, stop: () => { stopped++; }, close() {}, ...playback }),
  });
  const target = { environment: 'local', sessionId: 'chat', messages: [], sending: false, activeTurnId: null, send: async (...args) => { sent.push(args); return true; } };
  session.update(target);
  return { session, target, sent, spoken, cancelled, mutes, get callbacks() { return callbacks; }, get stopped() { return stopped; }, get closed() { return closed; } };
}

test('unlocked calls merge pending clips for one review, pause capture and preserve playback', async () => {
  const response = deferred(), playing = deferred(); let calls = 0;
  const f = sessionFixture({ transcribe: async () => { calls++; return response.promise; } }, { speak: () => playing.promise });
  try {
    await f.session.start('call');
    f.session.update({ ...f.target, sending: true, activeTurnId: 'turn', messages: [{ id: 'reply', role: 'assistant', turnId: 'turn', content: '继续处理。' }] });
    const before = f.stopped;
    for (let i = 0; i < 3; i++) f.callbacks.clip(new Blob(['external audio'], { type: 'audio/webm' }));
    await pause(); response.resolve({ text: '背景视频里的声音' }); await pause(); await pause();
    assert.equal(calls, 3); assert.equal(f.sent.length, 0); assert.equal(f.stopped, before);
    assert.equal(f.session.snapshot().reviewText, '背景视频里的声音 背景视频里的声音 背景视频里的声音'); assert.equal(f.session.snapshot().queuedClips, 0);
    assert.equal(f.mutes.at(-1), true); assert.equal(f.session.snapshot().speakerLocked, false);
    f.callbacks.clip(new Blob(['more noise'])); f.session.finishUtterance(); await pause(); assert.equal(calls, 3);
    f.session.review('我确认发送的内容'); f.session.review('重复点击'); await pause(); await pause();
    assert.deepEqual(f.sent, [['我确认发送的内容', { immediate: true }]]); assert.equal(f.stopped, before + 1);
    assert.equal(f.mutes.at(-1), false);
  } finally { playing.resolve(); f.session.end(); }
});

test('a previously verified caller requires review again when the host no longer verifies this clip', async () => {
  let verified = true;
  const f = sessionFixture({ transcribe: async () => ({ text: '完整的一句话', ...(verified ? { speakerVerified: true } : {}) }) });
  await f.session.start('call'); f.session.finishUtterance(); await pause(); await pause();
  assert.equal(f.sent.length, 1); assert.equal(f.session.snapshot().speakerLocked, true);
  verified = false; f.session.finishUtterance(); await pause(); await pause();
  assert.equal(f.sent.length, 1); assert.equal(f.session.snapshot().speakerLocked, false);
  f.session.mute(); f.session.review(''); assert.equal(f.mutes.at(-1), true, 'dismiss respects explicit mute');
  f.session.end();
});

test('Kokoro warm delivery joins available short sentences without delaying the first reply', async () => {
  const f = sessionFixture({ settings: async () => ({ ...defaultVoiceSettings, hasApiKey: true, engine: 'kokoro', kokoroStyle: 'warm' }), modelStatus: async () => ({ state: 'installed' }) });
  await f.session.start('call');
  f.session.update({ ...f.target, sending: true, activeTurnId: 'turn', messages: [{ id: 'reply', role: 'assistant', turnId: 'turn', content: '我在听。你可以慢慢说。' }] });
  await pause(); assert.deepEqual(f.spoken, [['我在听。 你可以慢慢说。', 'female']]); f.session.end();
});

test('local voice presets persist independently, validate bank bounds and migrate old settings', () => {
  const { instance } = service(fetch);
  const legacy = { ...systemVoiceSettings, kokoroFemaleVoice: undefined, kokoroMaleVoice: undefined, kokoroStyle: undefined };
  assert.equal(validateVoiceSettings(legacy).kokoroStyle, 'warm');
  instance.save({ ...legacy, kokoroFemaleVoice: 33, kokoroMaleVoice: 70, kokoroStyle: 'neutral' });
  assert.equal(instance.settings().kokoroFemaleVoice, 33); assert.equal(instance.settings().kokoroMaleVoice, 70);
  for (const patch of [{ kokoroFemaleVoice: 58 }, { kokoroFemaleVoice: 3.2 }, { kokoroMaleVoice: 57 }, { kokoroMaleVoice: 103 }, { kokoroStyle: 'invented' }]) assert.throws(() => validateVoiceSettings({ ...legacy, ...patch }));
  const { kokoroPresets } = compile('src/features/voice/kokoroPresets.ts');
  assert.deepEqual(kokoroPresets.female[0], { value: 3, name: 'zf_001' });
  assert.deepEqual(kokoroPresets.male.at(-1), { value: 102, name: 'zm_100' });
});

test('optional local recognition checks availability without downloading and works with system TTS without a key', async () => {
  let installs = 0;
  const config = { ...systemVoiceSettings, recognitionEngine: 'sensevoice', hasApiKey: false };
  const unavailable = sessionFixture({ settings: async () => config, modelStatus: async () => ({ state: 'not-installed' }), installModel: () => { installs++; } });
  await unavailable.session.start('recording');
  assert.match(unavailable.session.snapshot().error, /安装本地识别模型/); assert.equal(unavailable.callbacks, undefined); assert.equal(installs, 0); unavailable.session.end();
  const available = sessionFixture({ settings: async () => config, modelStatus: async () => ({ state: 'installed' }),
    capabilities: async () => ({ available: true, recognizers: [], voices: [{ language: 'zh-CN', gender: 'female', id: 'local-female' }] }) });
  await available.session.start('call'); assert.equal(available.session.snapshot().phase, 'listening'); assert.equal(available.session.snapshot().error, '');
  available.session.end();
});
test('single recording sends ordinary text and never speaks the reply', async () => {
  const f = sessionFixture(); await f.session.start('recording'); assert.equal(f.sent.length, 0);
  f.session.finishRecording(); await pause(); await pause();
  assert.deepEqual(f.sent, [['请继续', undefined]]); assert.equal(f.session.snapshot().mode, 'idle');
  f.session.update({ ...f.target, messages: [{ id: 'reply', role: 'assistant', content: '好的。' }] });
  assert.equal(f.spoken.length, 0); assert.ok(f.closed); f.session.end();
});
test('recording Send dismisses immediately, releases capture and submits once after delayed transcription', async () => {
  const response = deferred(); let transcriptions = 0;
  const f = sessionFixture({ transcribe: () => { transcriptions++; return response.promise; } });
  await f.session.start('recording'); f.session.finishRecording();
  assert.equal(f.session.snapshot().background, true); assert.equal(f.session.snapshot().phase, 'transcribing');
  assert.ok(f.closed); assert.equal(f.sent.length, 0);
  f.session.finishRecording(); f.session.retry(); await pause();
  assert.equal(transcriptions, 1); assert.equal(f.cancelled.length, 0);
  response.resolve({ text: '后台发送' }); await pause(); await pause();
  assert.deepEqual(f.sent, [['后台发送', undefined]]); assert.equal(f.session.snapshot().mode, 'idle');
});
test('background recording failures preserve a retry without reopening the modal', async () => {
  let attempts = 0;
  const f = sessionFixture({ transcribe: async () => { if (++attempts === 1) throw Error('暂时失败'); return { text: '录音已保留' }; } });
  await f.session.start('recording'); f.session.finishRecording(); await pause(); await pause();
  assert.equal(f.session.snapshot().background, true); assert.equal(f.session.snapshot().retryAvailable, true);
  assert.equal(f.sent.length, 0); f.session.retry(); f.session.retry(); await pause(); await pause();
  assert.equal(attempts, 2); assert.deepEqual(f.sent, [['录音已保留', undefined]]);
});
test('cancel or conversation switch during background transcription cannot submit late text', async () => {
  for (const switchConversation of [false, true]) {
    const response = deferred(); const f = sessionFixture({ transcribe: () => response.promise });
    await f.session.start('recording'); f.session.finishRecording(); await pause();
    if (switchConversation) f.session.update({ ...f.target, sessionId: 'another' }); else f.session.end();
    response.resolve({ text: '不能发送' }); await pause(); await pause();
    assert.equal(f.sent.length, 0); assert.equal(f.session.snapshot().mode, 'idle'); assert.ok(f.cancelled.length);
  }
});
test('call streams text, changes voice, interrupts audio independently, and ends on conversation switch', async () => {
  const f = sessionFixture(); await f.session.start('call'); await f.session.setVoice('male');
  f.callbacks.clip(new Blob(['audio'], { type: 'audio/webm' })); await pause(); await pause();
  assert.equal(f.sent[0][1].immediate, true);
  const target = { ...f.target, sending: true, activeTurnId: 'turn', messages: [{ id: 'reply', role: 'assistant', turnId: 'turn', content: '第一句。下一句' }] };
  f.session.update(target); await pause(); assert.deepEqual(f.spoken, [['第一句。', 'male']]);
  const before = f.stopped; f.callbacks.speech(); assert.equal(f.stopped, before, 'activity without confirmed text cannot interrupt');
  f.session.update({ ...target, messages: [{ ...target.messages[0], content: '第一句。下一句。' }] }); await pause(); assert.equal(f.spoken.length, 2);
  f.callbacks.clip(new Blob(['audio'], { type: 'audio/webm' })); await pause(); await pause(); assert.ok(f.stopped > before, 'confirmed speech still interrupts');
  f.session.update({ ...target, sessionId: 'other' }); assert.equal(f.session.snapshot().mode, 'idle');
});
test('noise, empty ASR, uncertain fragments, playback echo and ASR failure preserve active playback', async () => {
  for (const text of ['', 'I.', '嗯', '我会帮你检查最新的市场行情。', null]) {
    const playing = deferred(); let stops = 0;
    const f = sessionFixture({ transcribe: async () => { if (text === null) throw Error('识别暂时不可用'); return { text }; } },
      { speak: () => playing.promise, stop: () => { stops++; } });
    try {
      await f.session.start('call');
      f.session.update({ ...f.target, sending: true, activeTurnId: 'turn', messages: [{ id: 'reply', role: 'assistant', turnId: 'turn', content: '我会帮你检查最新的市场行情。' }] });
      await pause(); assert.equal(f.session.snapshot().speaking, true);
      const before = stops;
      f.callbacks.speech(); f.callbacks.clip(new Blob(['noise'], { type: 'audio/webm' })); await pause(); await pause();
      assert.equal(stops, before, `ASR ${text} must not stop speech`); assert.equal(f.session.snapshot().speaking, true); assert.equal(f.sent.length, 0);
      if (text) {
        assert.equal(f.session.snapshot().reviewText, text);
        f.session.review('请打开浏览器'); await pause(); await pause();
        assert.equal(stops, before + 1); assert.equal(f.sent[0][0], '请打开浏览器');
      }
    } finally { playing.resolve(); f.session.end(); }
  }
});

test('foreign and uncertain speakers never interrupt, enter review, retry text or steer a running Agent', async () => {
  for (const speaker of ['rejected', 'uncertain']) {
    const playing = deferred(); let stops = 0;
    const f = sessionFixture({ transcribe: async () => ({ text: '', speaker }) }, { speak: () => playing.promise, stop: () => { stops++; } });
    try {
      await f.session.start('call');
      f.session.update({ ...f.target, sending: true, activeTurnId: 'turn', messages: [{ id: 'reply', role: 'assistant', turnId: 'turn', content: '我会继续处理你的任务。' }] });
      await pause(); const before = stops;
      f.callbacks.clip(new Blob(['foreign voice'], { type: 'audio/webm' })); await pause(); await pause();
      assert.equal(stops, before); assert.equal(f.session.snapshot().speaking, true); assert.equal(f.session.snapshot().muted, false);
      assert.equal(f.sent.length, 0); assert.equal(f.session.snapshot().reviewText, ''); assert.equal(f.session.snapshot().retryAvailable, false);
      assert.ok(f.session.snapshot().speakerNotice); f.session.retry(); f.session.review('旁人的命令'); await pause(); assert.equal(f.sent.length, 0);
      f.session.end(); await f.session.start('call'); assert.equal(f.session.snapshot().speakerNotice, undefined);
    } finally { playing.resolve(); f.session.end(); }
  }
});
test('rejected dictation cannot bypass identity verification through retry', async () => {
  let attempts = 0;
  const f = sessionFixture({ transcribe: async () => { attempts++; return { text: '', speaker: 'rejected' }; } });
  await f.session.start('recording'); f.session.finishRecording(); await pause(); await pause();
  assert.equal(f.sent.length, 0); assert.ok(f.session.snapshot().error.includes('声纹'));
  f.session.retry(); await pause(); await pause(); assert.equal(attempts, 2); assert.equal(f.sent.length, 0); f.session.end();
});

test('activity gate rejects taps, hum, pure tones and broadband noise but accepts sustained speech bands', () => {
  const spectrum = pairs => { const values = new Float32Array(1024).fill(-100); for (const [bin, db] of pairs) values[bin] = db; return values; };
  const voice = spectrum([[7, -30], [14, -33], [21, -32], [28, -34], [35, -36], [42, -36], [49, -38]]);
  const tone = spectrum([[19, -20]]), hum = spectrum([[2, -20], [3, -24]]), broadband = new Float32Array(1024).fill(-35);
  for (const sound of [tone, hum, broadband]) {
    const activity = new VoiceActivity();
    for (let time = 60; time <= 3000; time += 60) assert.equal(activity.update(.1, sound, 48000, time).started, false);
  }
  const tap = new VoiceActivity();
  for (let time = 60; time <= 240; time += 60) assert.equal(tap.update(.1, voice, 48000, time).started, false);
  for (let time = 300; time <= 1000; time += 60) assert.equal(tap.update(0, new Float32Array(1024).fill(-Infinity), 48000, time).started, false);
  const activity = new VoiceActivity(); let starts = 0;
  for (let time = 60; time <= 1200; time += 60) if (activity.update(.03, voice, 48000, time).started) starts++;
  assert.equal(starts, 1); activity.reset();
  assert.equal(activity.update(.03, voice, 48000, 2000).started, false, 'a new segment must not inherit the old onset');
});

test('playback echo comparison tolerates punctuation and small ASR errors, without rejecting short commands', () => {
  assert.equal(isVoicePlaybackEcho('我先帮你核对最新的市场行情', ['我先帮你核对最新的市场行情。']), true);
  assert.equal(isVoicePlaybackEcho('我先帮你核对最新的市长行情', ['我先帮你核对最新的市场行情。']), true);
  assert.equal(isVoicePlaybackEcho('Let us check the browser', ['Let us check the browser.']), true);
  for (const text of ['停', '好', '打开 Chrome', '我要打开设置页面']) assert.equal(isVoicePlaybackEcho(text, ['好的，我要帮你核对市场行情。']), false);
});

test('late transcription after hangup cannot submit; first message can adopt its new session', async () => {
  const response = deferred(); const f = sessionFixture({ transcribe: () => response.promise });
  await f.session.start('call'); f.callbacks.clip(new Blob(['audio'], { type: 'audio/webm' })); await pause();
  f.session.end(); response.resolve({ text: 'late' }); await pause(); assert.equal(f.sent.length, 0); assert.ok(f.cancelled.length);
  const fresh = sessionFixture(); fresh.target.sessionId = '';
  fresh.target.send = async () => { fresh.session.update({ ...fresh.target, sessionId: 'created' }); return true; };
  fresh.session.update(fresh.target); await fresh.session.start('call'); fresh.callbacks.clip(new Blob(['audio'], { type: 'audio/webm' })); await pause(); await pause();
  assert.equal(fresh.session.snapshot().mode, 'call'); fresh.session.end();
});
test('task stop and revised assistant text stop queued audio without ending the call', async () => {
  const f = sessionFixture(); await f.session.start('call');
  const message = { id: 'reply', role: 'assistant', turnId: 'turn', content: '开始。' };
  f.session.update({ ...f.target, sending: true, activeTurnId: 'turn', messages: [message] }); await pause();
  const before = f.stopped;
  f.session.update({ ...f.target, stopping: true, messages: [message] });
  assert.ok(f.stopped > before); assert.equal(f.session.snapshot().mode, 'call');
  f.session.update({ ...f.target, sending: true, messages: [{ ...message, id: 'revision', content: '旧的说法。' }] }); await pause();
  const beforeRevision = f.stopped;
  f.session.update({ ...f.target, sending: true, messages: [{ ...message, id: 'revision', content: '更正。' }] });
  assert.ok(f.stopped > beforeRevision); f.session.end();
});
test('failed send retains transcript, pauses call and retries once without another transcription', async () => {
  let transcriptions = 0, attempts = 0;
  const f = sessionFixture({ transcribe: async () => { transcriptions++; return { text: '保留这句话', speakerVerified: true }; } });
  f.target.send = async () => ++attempts > 1; f.session.update(f.target);
  await f.session.start('call'); f.callbacks.clip(new Blob(['audio'], { type: 'audio/webm' })); await pause(); await pause();
  assert.match(f.session.snapshot().error, /未发送/); assert.equal(f.session.snapshot().muted, true);
  f.session.retry(); await pause(); await pause(); assert.equal(transcriptions, 1); assert.equal(attempts, 2); f.session.end();
});

test('failed transcription retains audio and exposes retry before any transcript exists', async () => {
  let attempts = 0;
  const f = sessionFixture({ transcribe: async () => { if (++attempts === 1) throw Error('服务暂不可用'); return { text: '重试成功', speakerVerified: true }; } });
  await f.session.start('call'); f.callbacks.clip(new Blob(['audio'], { type: 'audio/webm' })); await pause(); await pause();
  assert.equal(f.session.snapshot().transcript, ''); assert.equal(f.session.snapshot().retryAvailable, true);
  assert.equal(f.session.snapshot().muted, true); assert.equal(f.sent.length, 0);
  f.session.retry(); await pause(); await pause();
  assert.equal(f.session.snapshot().retryAvailable, false); assert.equal(f.sent.length, 1); assert.equal(f.sent[0][0], '重试成功'); f.session.end();
});
const { submissionReceipt } = compile('src/shared/submissionReceipt.ts');
const { VoiceProgress, needsVoiceReview } = compile('src/features/voice/voiceProgress.ts');

test('voice acceptance frees transcription before a long Agent turn completes; failures are not acknowledged', async () => {
  const completion = deferred(); let active = true;
  const f = sessionFixture();
  f.target.send = text => submissionReceipt(async accepted => { f.sent.push(text); accepted(); await completion.promise; active = false; });
  f.session.update(f.target); await f.session.start('call');
  for (let i = 0; i < 5; i++) { f.callbacks.clip(new Blob(['audio'], { type: 'audio/webm' })); await pause(); await pause(); }
  assert.equal(f.sent.length, 5); assert.equal(active, true); assert.equal(f.session.snapshot().queuedClips, 0);
  assert.equal(f.session.snapshot().phase, 'listening'); assert.equal(f.session.snapshot().capturePaused, false);
  completion.resolve(); await pause(); assert.equal(active, false); f.session.end();
  assert.equal(await submissionReceipt(async () => {}), false);
  assert.equal(await submissionReceipt(async () => { throw Error('not admitted'); }), false);
  assert.equal(await submissionReceipt(async accepted => { accepted(); throw Error('later turn failed'); }), true);
});

test('ambiguous fragments require review; confirmation is sent once and useful short commands still work', async () => {
  for (const text of ['嗯。', '呃', 'I.', '啊 嗯']) assert.equal(needsVoiceReview(text), true);
  for (const text of ['好', '停', '不', 'OK', '打开 Chrome']) assert.equal(needsVoiceReview(text), false);
  const f = sessionFixture({ transcribe: async () => ({ text: 'I.' }) }); await f.session.start('call');
  f.callbacks.clip(new Blob(['audio'], { type: 'audio/webm' })); await pause(); await pause();
  assert.equal(f.sent.length, 0); assert.equal(f.session.snapshot().reviewText, 'I.');
  f.session.review('打开 Chrome'); f.session.review('打开 Chrome'); await pause(); await pause();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0][0], '打开 Chrome'); assert.equal(f.session.snapshot().reviewText, ''); f.session.end();
});

test('ASR backpressure resumes on drain and respects explicit microphone mute', async () => {
  const gates = [deferred(), deferred(), deferred()]; let at = 0;
  const f = sessionFixture({ transcribe: () => gates[at++].promise }); await f.session.start('call');
  for (let i = 0; i < 3; i++) f.callbacks.clip(new Blob(['audio'], { type: 'audio/webm' }));
  await pause(); assert.equal(f.session.snapshot().capturePaused, true); assert.equal(f.session.snapshot().queuedClips, 3);
  f.session.mute(); gates[0].resolve({ text: '第一条', speakerVerified: true }); await pause(); await pause();
  gates[1].resolve({ text: '第二条', speakerVerified: true }); await pause(); await pause();
  assert.equal(f.session.snapshot().capturePaused, false); assert.equal(f.session.snapshot().muted, true);
  gates[2].resolve({ text: '第三条', speakerVerified: true }); await pause(); await pause();
  assert.equal(f.session.snapshot().queuedClips, 0); assert.equal(f.sent.length, 0, 'explicit mute holds the collected turn');
  f.session.mute(); await pause(); await pause();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0][0], '第一条 第二条 第三条'); f.session.end();
});

const progressMessage = (id, title, extra = {}) => ({ id: 'm-'+id, role: 'assistant', turnId: 't', content: '', toolExecutions: [{ id, name: 'browser', state: 'running', metadata: { displayTitles: { zh: title, en: 'Checking the page' } }, arguments: 'secret arguments', ...extra }] });
test('tool progress remains visual and exposes no speech announcement', () => {
  const p = new VoiceProgress(), old = progressMessage('old', '旧状态');
  const a = progressMessage('a', '核对行情'), hidden = { ...progressMessage('hidden', '隐藏内容'), metadata: { visibility: 'internal' } };
  const silent = progressMessage('s', '记录习惯', { name: 'summary_for_user' });
  const messages = [old, hidden, silent, { id: 'final', role: 'assistant', content: '', turnId: 't', loopHistory: [a] }];
  assert.deepEqual(p.update(messages, 't', 'zh'), { activity: '核对行情' });
  assert.deepEqual(p.update(messages, 'other', 'zh'), { activity: '' });
});

test('loop commentary is flushed at a tool boundary but tool progress stays silent', async () => {
  const f = sessionFixture(); await f.session.start('call');
  const first = progressMessage('a', '核对行情');
  f.session.update({ ...f.target, activeTurnId: 't', sending: true, messages: [first] }); await pause();
  assert.deepEqual(f.spoken, []); assert.equal(f.session.snapshot().activity, '核对行情');
  f.session.update({ ...f.target, activeTurnId: 't', sending: true, waiting: true, messages: [first] }); await pause();
  assert.equal(f.spoken.length, 0); assert.equal(f.session.snapshot().agentWaiting, true);
  const transcript = new SpokenTranscript(); transcript.reset([]);
  const loop = { ...first, content: '我来查一下', id: 'commentary' };
  assert.deepEqual(transcript.update([{ id:'answer',role:'assistant',turnId:'t',content:'',loopHistory:[loop] }],'t',true), ['我来查一下']);
  assert.deepEqual(transcript.update([loop],'t',true), []); f.session.end();
});

test('Kokoro stays optional, needs no account and does not call the system voice backend', async () => {
  let synthesized=0, requestedModel;
  const root=mkdtempSync(resolve('tmp/voice-kokoro-service-'));
  const service=new VoiceService(join(root,'settings.json'),{speech:{speak:async(input,config)=>{synthesized++;assert.equal(input.voice,'male');assert.equal(config.engine,'kokoro');}},fetch:async()=>assert.fail('unexpected network'),encrypt:String,decrypt:()=>assert.fail('unexpected credentials')});
  assert.equal(service.settings().engine,'system');
  service.save({...systemVoiceSettings,engine:'kokoro'});
  await service.speak(1,{id:'neural',text:'你好',voice:'male'},()=>{});assert.equal(synthesized,1);
  const f=sessionFixture({settings:async()=>({...defaultVoiceSettings,engine:'kokoro',hasApiKey:true}),modelStatus:async kind=>{requestedModel=kind;return {state:'not-installed'};}});
  await f.session.start('call');assert.equal(requestedModel,'speech');assert.match(f.session.snapshot().error,/安装本地自然音色/);f.session.end();
  const legacy=validateVoiceSettings({...systemVoiceSettings,recognitionFormatting:undefined});assert.equal(legacy.recognitionFormatting,'verbatim');
  assert.equal(validateVoiceSettings({...legacy,recognitionFormatting:'formatted'}).recognitionFormatting,'formatted');
});
test('a prior tool boundary does not flush every token of the following streamed reply',()=>{
 const transcript = new SpokenTranscript();transcript.reset([]);
 const message = {...progressMessage('a','核对页面'),content:'先核对'};
 assert.deepEqual(transcript.update([message],'t',true),['先核对']);
 assert.deepEqual(transcript.update([{...message,content:'先核对结果'}],'t',true),[]);
 assert.deepEqual(transcript.update([{...message,content:'先核对结果如下。'}],'t',true),['结果如下。']);
});

const clip = (f, clock, reason = 'silence') => f.callbacks.clip(new Blob(['audio'], { type: 'audio/webm' }), { lastSpeechAt: clock.now(), reason });
const settle = async () => { await pause(); await pause(); };
test('thinking pauses and resumed speech combine as one turn after three seconds of final silence', async () => {
  const clock = turnClock(), lines = ['我想了解', '这个问题的原因'];
  const f = sessionFixture({ transcribe: async () => ({ text: lines.shift(), speakerVerified: true }) }, {}, clock);
  await f.session.start('call'); f.callbacks.speech(); clip(f, clock); await settle();
  clock.advance(2800); assert.equal(f.sent.length, 0); assert.equal(f.session.snapshot().draftTranscript, '我想了解');
  f.callbacks.speech(); clock.advance(5000); assert.equal(f.sent.length, 0, 'old text cannot submit while capture contains new speech');
  clip(f, clock); await settle(); clock.advance(2999); assert.equal(f.sent.length, 0);
  clock.advance(1); await settle(); assert.deepEqual(f.sent, [['我想了解 这个问题的原因', { immediate: true }]]);
  assert.equal(f.session.snapshot().inputPending, false); f.session.end();
});
test('an onset just before the deadline postpones submission before VAD confirms speech', async () => {
  const clock = turnClock(), f = sessionFixture({}, {}, clock);
  await f.session.start('call'); clip(f, clock); await settle(); clock.advance(2900);
  f.callbacks.activity(clock.now()); clock.advance(200); assert.equal(f.sent.length, 0);
  clock.advance(2800); await settle(); assert.equal(f.sent.length, 1); f.session.end();
});
test('late first ASR waits for continuing speech and all later queued transcriptions', async () => {
  const clock = turnClock(), gates = [deferred(), deferred()]; let i = 0;
  const f = sessionFixture({ transcribe: () => gates[i++].promise }, {}, clock);
  await f.session.start('call'); clip(f, clock); await settle();
  clock.advance(2000); f.callbacks.speech(); clock.advance(8000);
  gates[0].resolve({ text: '先检查配置', speakerVerified: true }); await settle(); clock.advance(1000);
  assert.equal(f.sent.length, 0);
  clip(f, clock); await settle(); clock.advance(8000); assert.equal(f.sent.length, 0, 'ASR must finish before commit');
  gates[1].resolve({ text: '然后告诉我结果', speakerVerified: true }); await settle(); clock.advance(0); await settle();
  assert.deepEqual(f.sent.map(v => v[0]), ['先检查配置 然后告诉我结果']); f.session.end();
});
test('loop guidance waits five seconds and patient mode waits six; only committed input interrupts', async () => {
  for (const [patient, sending, delay] of [[false, true, 5000], [true, false, 6000], [true, true, 6000]]) {
    const clock = turnClock(), f = sessionFixture({ settings: async () => ({ ...defaultVoiceSettings, hasApiKey: true, turnEndPause: patient ? 'patient' : 'normal' }) }, {}, clock);
    f.session.update({ ...f.target, sending }); await f.session.start('call');
    const before = f.stopped; clip(f, clock); await settle(); clock.advance(delay - 1);
    assert.equal(f.sent.length, 0); assert.equal(f.stopped, before);
    clock.advance(1); await settle(); assert.equal(f.sent.length, 1); assert.equal(f.stopped, before + 1); f.session.end();
  }
});
test('45 second recording rotation remains part of the same utterance', async () => {
  const clock = turnClock(); let i = 0;
  const f = sessionFixture({ transcribe: async () => ({ text: ++i === 1 ? '很长的第一部分' : '继续说明的第二部分', speakerVerified: true }) }, {}, clock);
  await f.session.start('call'); f.callbacks.speech(); clock.advance(45000); clip(f, clock, 'limit'); await settle();
  clock.advance(100); f.callbacks.speech(); clock.advance(10000); assert.equal(f.sent.length, 0);
  clip(f, clock); await settle(); clock.advance(3000); await settle();
  assert.deepEqual(f.sent.map(v => v[0]), ['很长的第一部分 继续说明的第二部分']); f.session.end();
});
test('Finished speaking during ASR waits for the result then bypasses silence, without duplicate sends', async () => {
  const clock = turnClock(), gate = deferred();
  const f = sessionFixture({ transcribe: () => gate.promise }, {}, clock, { finish: () => false });
  await f.session.start('call'); clip(f, clock); await settle(); f.session.finishUtterance(); f.session.finishUtterance();
  clock.advance(0); assert.equal(f.sent.length, 0);
  gate.resolve({ text: '完整的话', speakerVerified: true }); await settle(); clock.advance(0); await settle();
  assert.deepEqual(f.sent.map(v => v[0]), ['完整的话']); assert.equal(f.mutes.at(-1), false); f.session.end();
});
test('unverified fragments require one review of the complete turn even if another fragment is verified', async () => {
  const clock = turnClock(); let i = 0;
  const f = sessionFixture({ transcribe: async () => ++i === 1 ? { text: '前半句' } : { text: '后半句', speakerVerified: true } }, {}, clock);
  await f.session.start('call'); clip(f, clock); await settle(); clock.advance(2000);
  f.callbacks.speech(); clip(f, clock); await settle(); assert.equal(f.session.snapshot().reviewText, '');
  clock.advance(3000); await settle(); assert.equal(f.sent.length, 0); assert.equal(f.session.snapshot().reviewText, '前半句 后半句');
  assert.equal(f.mutes.at(-1), true); f.session.review('前半句 后半句'); await settle();
  assert.equal(f.sent.length, 1); f.session.end();
});
test('drafts survive a failed continuation and retry without resending the first fragment separately', async () => {
  const clock = turnClock(); let i = 0;
  const f = sessionFixture({ transcribe: async () => { if (++i === 2) throw Error('temporary'); return { text: i === 1 ? '保留前半句' : '重试后半句', speakerVerified: true }; } }, {}, clock);
  await f.session.start('call'); clip(f, clock); await settle(); clock.advance(1000); clip(f, clock); await settle();
  clock.advance(10000); assert.equal(f.sent.length, 0); assert.equal(f.session.snapshot().retryAvailable, true);
  f.session.retry(); await settle(); clock.advance(0); await settle();
  assert.deepEqual(f.sent.map(v => v[0]), ['保留前半句 重试后半句']); f.session.end();
});
test('disconnect, settings, hangup and switching conversations prevent pending automatic submissions', async () => {
  for (const action of ['disconnect', 'settings', 'end', 'switch']) {
    const clock = turnClock(), f = sessionFixture({}, {}, clock);
    await f.session.start('call'); clip(f, clock); await settle();
    if (action === 'disconnect') f.callbacks.error('麦克风断开');
    if (action === 'settings') f.session.setSettingsOpen(true);
    if (action === 'end') f.session.end();
    if (action === 'switch') f.session.update({ ...f.target, sessionId: 'other' });
    clock.advance(20000); await settle(); assert.equal(f.sent.length, 0, action); f.session.end(); assert.equal(clock.pending, 0);
  }
});
test('only verified standalone interruption commands bypass the normal pause', async () => {
  for (const [text, verified, immediate] of [['先停一下', true, true], ['stop speaking', true, true], ['等一下再打开页面', true, false], ['停一下', false, false]]) {
    const clock = turnClock(), f = sessionFixture({ transcribe: async () => ({ text, speakerVerified: verified }) }, {}, clock);
    await f.session.start('call'); clip(f, clock); await settle(); clock.advance(0); await settle();
    assert.equal(f.sent.length, immediate ? 1 : 0); f.session.end();
  }
});
test('voice pause preference persists and existing profiles migrate to normal', () => {
  const { instance } = service(fetch);
  assert.equal(validateVoiceSettings({ ...defaultVoiceSettings, turnEndPause: undefined }).turnEndPause, 'normal');
  instance.save({ ...defaultVoiceSettings, turnEndPause: 'patient' }); assert.equal(instance.settings().turnEndPause, 'patient');
  assert.throws(() => validateVoiceSettings({ ...defaultVoiceSettings, turnEndPause: 'instant' }));
});

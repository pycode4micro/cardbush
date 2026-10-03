import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { inspectCustomSpeechModel, validateCustomSpeech } from '../dist-electron/customSpeechModel.js';
import { CustomSpeech } from '../dist-electron/customSpeech.js';
import { VoiceService, validateVoiceSettings } from '../dist-electron/voiceService.js';
import { defaultVoiceSettings, defaultCustomSpeechSettings } from '../dist-electron/voiceTypes.js';

const root = fs.mkdtempSync(path.resolve('tmp/custom-speech-test-'));
const put = (dir, name, data = 'data') => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'object' ? JSON.stringify(data) : data); };
function qwen(name = 'qwen') {
  const dir = path.join(root, name);
  put(dir, 'config.json', { model_type: 'qwen3_tts', tts_model_type: 'custom_voice', tokenizer_type: 'qwen3_tts_tokenizer_12hz', tts_model_size: '1b7', talker_config: { spk_id: { serena: 1, uncle_fu: 2 } } });
  for (const name of ['tokenizer_config.json', 'preprocessor_config.json', 'vocab.json', 'generation_config.json', 'speech_tokenizer/config.json', 'speech_tokenizer/preprocessor_config.json']) put(dir, name, {});
  for (const name of ['merges.txt', 'model.safetensors', 'speech_tokenizer/model.safetensors']) put(dir, name);
  return dir;
}
function kokoro(name = 'kokoro') {
  const dir = path.join(root, name);
  for (const name of ['model.int8.onnx', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'date-zh.fst', 'number-zh.fst', 'phone-zh.fst']) put(dir, name);
  fs.mkdirSync(path.join(dir, 'espeak-ng-data'));
  const fd = fs.openSync(path.join(dir, 'voices.bin'), 'w'); fs.ftruncateSync(fd, 103 * 510 * 256 * 4); fs.closeSync(fd);
  return dir;
}
const config = directory => ({ ...defaultVoiceSettings, engine: 'custom', customSpeech: { ...defaultCustomSpeechSettings, directory } });
const noNetwork = () => { throw Error('Unexpected network or credential access'); };

test('Qwen metadata reads presets without executing model code or loading weights', () => {
  const dir = qwen(), before = fs.readdirSync(dir), model = inspectCustomSpeechModel(dir);
  assert.equal(model.kind, 'qwen3-customvoice'); assert.equal(model.supportsInstructions, true);
  assert.deepEqual(model.voices.map(v => v.id), ['serena', 'uncle_fu']);
  assert.equal(model.defaultFemaleVoice, 'serena'); assert.equal(model.defaultMaleVoice, 'uncle_fu');
  assert.deepEqual(fs.readdirSync(dir), before);
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))); json.tts_model_size = '0b6'; put(dir, 'config.json', json);
  assert.equal(inspectCustomSpeechModel(dir).supportsInstructions, false);
  json.tts_model_type = 'base'; put(dir, 'config.json', json);
  assert.throws(() => inspectCustomSpeechModel(dir), /CustomVoice/);
});
test('incomplete weights, code-loading metadata and escaping shard paths are rejected', () => {
  const dir = qwen('invalid');
  put(dir, 'tokenizer_config.json', { auto_map: { AutoTokenizer: 'custom.Tokenizer' } });
  assert.throws(() => inspectCustomSpeechModel(dir), /Python/);
  put(dir, 'tokenizer_config.json', {}); fs.unlinkSync(path.join(dir, 'model.safetensors'));
  put(dir, 'model.safetensors.index.json', { weight_map: { x: '../outside.safetensors' } });
  assert.throws(() => inspectCustomSpeechModel(dir), /路径/);
  put(dir, 'model.safetensors.index.json', { weight_map: { x: 'part.safetensors' } });
  assert.throws(() => inspectCustomSpeechModel(dir), /part.safetensors/);
  put(dir, 'part.safetensors'); assert.equal(inspectCustomSpeechModel(dir).kind, 'qwen3-customvoice');
  fs.unlinkSync(path.join(dir, 'speech_tokenizer/model.safetensors'));
  assert.throws(() => inspectCustomSpeechModel(dir), /模型目录/);
  assert.throws(() => validateCustomSpeech({ ...defaultCustomSpeechSettings, directory: 'relative' }), /完整/);
  assert.throws(() => validateCustomSpeech({ ...defaultCustomSpeechSettings, device: 'unknown' }), /设备/);
});
test('custom Kokoro routes imported data and gender to the existing verified runtime', async () => {
  const dir = kokoro(), calls = [];
  const backend = new CustomSpeech({ speakDirectory: async (...args) => { calls.push(args); args[3]({ id: args[0].id, pcm: 'AAA=', sampleRate: 24000 }); } }, () => true, 'unused');
  assert.equal(backend.inspect(dir).voices.length, 103);
  const chunks = []; await backend.speak({ id: 'male', text: '你好', voice: 'male' }, config(dir), new AbortController().signal, v => chunks.push(v));
  assert.deepEqual(calls[0][4], { directory: dir, sid: 58 }); assert.equal(chunks[0].id, 'male');
  assert.equal(fs.existsSync(path.join(dir, 'model.int8.onnx')), true, 'imported files stay in place');
  const missing = new CustomSpeech({}, () => false, 'unused'); assert.throws(() => missing.validate(config(dir)), /可选组件/);
  assert.throws(() => backend.validate({ ...config(dir), customSpeech: { ...config(dir).customSpeech, maleVoice: '999' } }), /音色/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(backend.speak({ id: 'cancel', text: '取消' }, config(dir), abort.signal, noNetwork));
  assert.equal(calls.length, 1);
});
test('custom settings persist, stay separate from ASR, and never fall through to cloud', async () => {
  const file = path.join(root, 'settings.json'), dir = qwen('service');
  let calls = 0;
  const deps = { fetch: noNetwork, encrypt: noNetwork, decrypt: noNetwork, customSpeech: {
    validate: value => assert.equal(value.customSpeech.directory, dir),
    speak: async (input, value, signal, emit) => { calls++; assert.equal(value.engine, 'custom'); emit({ id: input.id, pcm: 'AAA=', sampleRate: 24000 }); },
  } };
  const service = new VoiceService(file, deps);
  assert.equal(service.settings().engine, 'system');
  service.save(config(dir)); assert.equal(service.settings().hasApiKey, false);
  const reopened = new VoiceService(file, deps); assert.equal(reopened.settings().customSpeech.directory, dir);
  await reopened.speak(1, { id: 'custom', text: '你好' }, chunk => assert.equal(chunk.id, 'custom')); assert.equal(calls, 1);
  assert.equal(validateVoiceSettings({ ...config(dir), recognitionEngine: undefined }).recognitionEngine, 'system');
  fs.renameSync(dir, dir + '-moved'); assert.equal(reopened.settings().engine, 'custom', 'moved files do not prevent opening settings');
  reopened.save({ ...reopened.settings(), engine: 'system' });
  assert.equal(reopened.settings().engine, 'system');
  const missing = new VoiceService(file, { fetch: noNetwork, encrypt: noNetwork, decrypt: noNetwork });
  assert.throws(() => missing.save(config(dir)), /自定义本地/); assert.equal(missing.settings().engine, 'system');
});
test('custom synthesis cancellation is owner bound and keeps the service reusable', async () => {
  let started;
  const ready = new Promise(resolve => started = resolve);
  const service = new VoiceService(path.join(root, 'cancel.json'), { fetch: noNetwork, encrypt: noNetwork, decrypt: noNetwork,
    customSpeech: { validate: () => {}, speak: (_input, _value, signal) => new Promise((resolve, reject) => { started(signal); signal.addEventListener('abort', () => reject(Error('stopped')), { once: true }); }) } });
  service.save(config(root));
  const pending = service.speak(42, { id: 'speak', text: '取消测试' }, noNetwork), signal = await ready;
  service.cancel(43, 'speak'); assert.equal(signal.aborted, false);
  service.cancelOwner(42); await assert.rejects(pending, { name: 'VoiceCancelledError' });
});

test('primary Qwen persists at natural speed, keeps ASR and credentials, and routes both voices locally', async () => {
  const file = path.join(root, 'primary-qwen.json'), dir = qwen('primary');
  const calls = [];
  fs.writeFileSync(file, JSON.stringify({ ...defaultVoiceSettings, engine: 'kokoro', recognitionEngine: 'sensevoice', secret: 'encrypted-test-placeholder' }));
  const backend = new CustomSpeech({}, () => true, 'unused');
  const service = new VoiceService(file, { fetch: noNetwork, encrypt: noNetwork, decrypt: noNetwork,
    speech: { speak: noNetwork }, customSpeech: { validate: value => backend.validate(value),
      speak: async (input, settings, _signal, emit) => { calls.push([input.voice, settings.engine, settings.speed]); emit({ id: input.id, pcm: 'AAA=', sampleRate: 24000 }); } } });
  service.save({ ...service.settings(), engine: 'qwen', speed: 1.5,
    customSpeech: { ...defaultCustomSpeechSettings, directory: dir, pythonPath: process.execPath } });
  assert.equal(service.settings().engine, 'qwen'); assert.equal(service.settings().speed, 1);
  assert.equal(service.settings().recognitionEngine, 'sensevoice'); assert.equal(service.settings().hasApiKey, true);
  assert.equal(JSON.parse(fs.readFileSync(file)).secret, 'encrypted-test-placeholder');
  for (const voice of ['female', 'male']) await service.speak(1, { id: voice, text: '你好', voice }, () => {});
  assert.deepEqual(calls, [['female', 'qwen', 1], ['male', 'qwen', 1]]);
  assert.equal(validateVoiceSettings({ ...service.settings(), recognitionEngine: undefined }).recognitionEngine, 'system');
  assert.throws(() => service.save({ ...service.settings(), customSpeech: { ...service.settings().customSpeech, directory: kokoro('wrong-qwen-format') } }), /Qwen/);
  assert.equal(service.settings().customSpeech.directory, dir, 'invalid replacement cannot overwrite working settings');
  fs.renameSync(dir, dir + '-moved'); assert.equal(service.settings().engine, 'qwen');
  assert.throws(() => service.save(service.settings()), /模型目录/);
  service.save({ ...service.settings(), engine: 'system' }); assert.equal(service.settings().engine, 'system');
});

for (const engine of ['qwen', 'custom']) {
  test(`${engine} can finish cold synthesis beyond the ordinary 90-second deadline`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    const chunks = [];
    const service = new VoiceService(path.join(root, `cold-${engine}.json`), { fetch: noNetwork, encrypt: noNetwork, decrypt: noNetwork,
      customSpeech: { validate: () => {}, speak: (input, _settings, active, emit) => new Promise((resolve, reject) => {
        signal = active;
        const timer = setTimeout(() => { emit({ id: input.id, pcm: 'AAA=', sampleRate: 24000 }); resolve(); }, 95_000);
        active.addEventListener('abort', () => { clearTimeout(timer); reject(Error('aborted')); }, { once: true });
      }) } });
    service.save({ ...config(root), engine });
    const pending = service.speak(1, { id: 'cold', text: '你好' }, chunk => chunks.push(chunk));
    t.mock.timers.tick(91_000);
    assert.equal(signal.aborted, false, 'cold startup is not mistaken for cancellation');
    t.mock.timers.tick(4_000);
    await pending; assert.equal(chunks.length, 1);
  });
}

test('long local synthesis remains bounded, cancellable and separate from ASR deadlines', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  const hold = active => new Promise((_resolve, reject) => {
    signals.push(active); active.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  });
  const service = new VoiceService(path.join(root, 'cold-bounds.json'), { fetch: noNetwork, encrypt: noNetwork, decrypt: noNetwork,
    customSpeech: { validate: () => {}, speak: (_input, _config, active) => hold(active) },
    local: { transcribe: (_input, _config, active) => hold(active) } });
  service.save({ ...config(root), engine: 'qwen' });
  const expired = assert.rejects(service.speak(1, { id: 'timeout', text: '你好' }, noNetwork), /aborted/);
  t.mock.timers.tick(4 * 60_000); await expired; assert.equal(signals[0].aborted, true);
  const cancelled = assert.rejects(service.speak(1, { id: 'cancel', text: '你好' }, noNetwork), { name: 'VoiceCancelledError' });
  service.cancel(1, 'cancel'); await cancelled;
  const transcription = assert.rejects(service.transcribe(1, { id: 'asr', audio: new ArrayBuffer(44), mimeType: 'audio/wav' }), /aborted/);
  await Promise.resolve(); // Transcription awaits the optional speaker check before calling ASR.
  t.mock.timers.tick(91_000); await transcription;
  assert.equal(signals[2].aborted, true, 'Qwen choice does not extend recognition timeouts');
});

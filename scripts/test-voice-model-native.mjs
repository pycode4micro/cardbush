// Explicit development-machine installation only with --install-dev. Normal tests never download.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { VoiceModelStore } from '../dist-electron/voiceModelStore.js';
import { SenseVoice } from '../dist-electron/senseVoice.js';
import { WindowsVoice } from '../dist-electron/windowsVoice.js';
import { defaultVoiceSettings } from '../dist-electron/voiceTypes.js';
const cache = path.resolve('tmp/sensevoice-upstream');
const install = process.argv.includes('--install-dev');
const root = process.env.CARDBUSH_VOICE_TEST_MODEL_ROOT || (process.platform === 'win32' ? path.join(process.env.APPDATA, 'cardbush', 'voice-models') : 'tmp/voice-native-models');
const store = new VoiceModelStore(root, async (url, options) => {
  // Reuse archives downloaded from upstream in this session; the production
  // installer still verifies both archive and extracted-file hashes.
  const cached = path.join(cache, String(url).includes('2024-07-17') ? 'model-2024.tar.bz2' : process.platform === 'win32' ? 'runtime.tar.bz2' : 'linux-runtime.tar.bz2');
  if (fs.existsSync(cached)) return new Response(Readable.toWeb(fs.createReadStream(cached)), { headers: { 'content-length': String(fs.statSync(cached).size) } });
  return fetch(url, options);
});
if (install) {
  const timer = setInterval(() => { const state = store.status(); console.log(state.state, Math.round(state.downloadedBytes / 1e6) + ' MB'); }, 10000);
  try { assert.equal((await store.install()).state, 'installed', store.status().error); } finally { clearInterval(timer); }
}
if (store.status().state !== 'installed') { console.log('SKIP: opt-in local model is not installed.'); process.exit(0); }
const backend = new SenseVoice(store, path.resolve('tmp/voice-native-audio'));
const legacy = new WindowsVoice(path.resolve('dist-native/voice/CardBushVoiceHost.exe'));
const config = { ...defaultVoiceSettings, recognitionEngine: 'sensevoice' };
const reports = [];
const source = path.join(cache, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs');
for (const language of ['zh', 'en', 'mixed']) {
  const file = language === 'mixed' ? path.join(cache, 'mixed.wav') : path.join(source, language + '.wav');
  if (!fs.existsSync(file)) { console.log('SKIP: upstream public sample missing:', language); continue; }
  const wav = fs.readFileSync(file), audio = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.length);
  const started = performance.now();
  const result = await backend.transcribe(audio, config, AbortSignal.timeout(30000));
  assert.ok(result.text.length > 5);
  const row = { language, text: result.text, elapsedMs: Math.round(performance.now() - started) };
  try { row.windows = (await legacy.transcribe(audio, { ...defaultVoiceSettings, language: language === 'en' ? 'en-US' : 'zh-CN' }, AbortSignal.timeout(30000))).text; }
  catch (error) { row.windowsUnavailable = error.message; }
  if (language === 'mixed') {
    row.formatted = (await backend.transcribe(audio, { ...config, recognitionFormatting: 'formatted' }, AbortSignal.timeout(30000))).text;
    assert.match(row.text, /data science/i); assert.match(row.text, /again/i);
  }
  reports.push(row); console.log(JSON.stringify(row));
}
// Cancel an actual native inference and ensure temporary recordings are removed.
const sample = path.join(source, 'zh.wav');
if (fs.existsSync(sample)) {
  const wav = fs.readFileSync(sample), controller = new AbortController();
  const request = backend.transcribe(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.length), config, controller.signal);
  setTimeout(() => controller.abort(), 100); await assert.rejects(request);
  assert.deepEqual(fs.readdirSync(path.resolve('tmp/voice-native-audio')), []);
}
fs.writeFileSync('tmp/voice-sensevoice-benchmark.json', JSON.stringify({ model: store.status().version, root, reports }, null, 2));
console.log('Optional local model installed and tested:', store.directory);

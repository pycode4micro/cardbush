import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { WindowsVoice } from '../dist-electron/windowsVoice.js';
import { VoiceService } from '../dist-electron/voiceService.js';
import { defaultVoiceSettings } from '../dist-electron/voiceTypes.js';

const executable = path.resolve('dist-native/voice/CardBushVoiceHost.exe');
const local = new WindowsVoice(executable);
const signal = () => AbortSignal.timeout(30000);
function wave(pcm, sampleRate) {
  const audio = Buffer.alloc(44 + pcm.length);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(sampleRate, 24); audio.writeUInt32LE(sampleRate * 2, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(pcm.length, 40); pcm.copy(audio, 44); return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.length);
}

test('packaging includes both Windows voice helpers and builds them for development and release', () => {
  const packaging = yaml.load(readFileSync('electron-builder.yml', 'utf8'));
  const resource = packaging.win.extraResources.find(item => item.from === 'dist-native/voice');
  assert.equal(resource?.to, 'voice');
  assert.deepEqual(resource.filter, ['CardBushVoiceHost.exe', 'CardBushSpeakerHost.exe']);
  assert.ok(packaging.extraResources.some(item => item.from === 'native/voice/custom_tts.py' && item.to === 'voice/custom_tts.py'), 'custom Python helper is available outside asar on supported desktop platforms');
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  for (const task of ['predev', 'build', 'test:voice']) assert.ok(scripts[task].includes('build-voice-native-host.mjs'));
});

test('unsupported platforms report local speech unavailable without network fallback', async () => {
  const backend = new WindowsVoice(executable, 'linux');
  assert.equal((await backend.capabilities(signal())).available, false);
  await assert.rejects(backend.speak({ id: 'test', text: '你好' }, defaultVoiceSettings, signal(), () => {}), /Windows/);
});

test('real Windows male/female synthesis and Chinese dictation need no key or network', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const capabilities = await local.capabilities(signal());
  if (!capabilities.recognizers.some(v => v.language === 'zh-CN') || !['female', 'male'].every(gender => capabilities.voices.some(v => v.language === 'zh-CN' && v.gender === gender))) {
    t.skip('Chinese Windows recognition and both voice packs must be installed.'); return;
  }
  const instance = new VoiceService(path.join(mkdtempSync(path.resolve('tmp/voice-native-')), 'settings.json'), {
    local, fetch: () => { throw Error('Network access forbidden in local mode'); }, encrypt: () => { throw Error('No key required'); }, decrypt: () => { throw Error('No key required'); },
  });
  assert.equal(instance.settings().engine, 'system'); assert.equal(instance.settings().hasApiKey, false);
  const audioByGender = [];
  for (const voice of ['female', 'male']) {
    const chunks = [];
    await instance.speak(1, { id: voice, text: '今天天气很好，我们一起去公园散步。', voice }, chunk => chunks.push(chunk));
    assert.ok(chunks.length > 0); assert.ok(chunks.every(c => c.sampleRate === chunks[0].sampleRate));
    const pcm = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.pcm, 'base64')));
    assert.ok(pcm.length > 1000 && pcm.some(v => v !== 0)); audioByGender.push(pcm);
    const result = await instance.transcribe(1, { id: 'recognize-' + voice, audio: wave(pcm, chunks[0].sampleRate), mimeType: 'audio/wav' });
    assert.match(result.text, /天气|公园/, 'Chinese round trip should retain recognizable words');
    t.diagnostic(`${voice}: ${chunks[0].sampleRate} Hz, ${pcm.length} PCM bytes, transcription: ${result.text}`);
  }
  assert.notDeepEqual(audioByGender[0], audioByGender[1]);
  await assert.rejects(local.speak({ id: 'missing', text: '你好' }, { ...defaultVoiceSettings, systemFemaleVoice: 'nonexistent-voice' }, signal(), () => {}), /未安装/);
});

test('Windows speech cancellation kills the native request', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
  const controller = new AbortController();
  const promise = local.speak({ id: 'cancel', text: '这是一段用于测试取消的文字。'.repeat(100) }, defaultVoiceSettings, controller.signal, () => {});
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(promise, /已取消/);
});

// Explicit, offline regression using an existing model/environment; never installs or changes user settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CustomSpeech } from '../dist-electron/customSpeech.js';
import { VoiceService } from '../dist-electron/voiceService.js';
import { defaultVoiceSettings, defaultQwenSpeechSettings } from '../dist-electron/voiceTypes.js';

const model = path.resolve(process.env.CARDBUSH_CUSTOM_TTS_MODEL ?? 'tmp/tts-audition/models/Qwen3-TTS-1.7B-CustomVoice');
const python = path.resolve(process.env.CARDBUSH_CUSTOM_TTS_PYTHON ?? `tmp/tts-audition/.venv/${process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'}`);
if (!fs.existsSync(model) || !fs.existsSync(python)) { console.log('SKIP custom speech native regression: local Qwen model/Python absent.'); process.exit(0); }
const root = fs.mkdtempSync(path.resolve('tmp/custom-speech-native-'));
const backend = new CustomSpeech({}, () => false, path.resolve('native/voice/custom_tts.py'));
const service = new VoiceService(path.join(root, 'voice.json'), { customSpeech: backend,
  fetch: () => { throw Error('Unexpected cloud request'); }, encrypt: () => { throw Error('No key required'); }, decrypt: () => { throw Error('No key required'); } });
const info = backend.inspect(model); assert.ok(info.voices.length > 1);
service.save({ ...defaultVoiceSettings, engine: 'qwen', customSpeech: { ...defaultQwenSpeechSettings, directory: model, pythonPath: python, language: 'Chinese' } });
for (const voice of ['female', 'male']) {
const start = performance.now(), chunks = [];
await service.speak(1, { id: 'custom-native', text: '别着急，我在听。我们慢慢说。', voice }, chunk => { assert.equal(chunk.sampleRate, 24000); chunks.push(Buffer.from(chunk.pcm, 'base64')); });
const pcm = Buffer.concat(chunks); assert.ok(pcm.length > 48000);
const wav = Buffer.alloc(44 + pcm.length); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
fs.writeFileSync(path.join(root, `qwen-${voice}.wav`), wav);
console.log(JSON.stringify({ voice, synthesisMs: Math.round(performance.now() - start), audioMs: Math.round(pcm.length / 48), output: path.join(root, `qwen-${voice}.wav`) }));
}

// A lightweight Python child exercises the same launcher and owned-process-tree cancellation.
const helper = path.join(root, 'wait.py'), pidFile = path.join(root, 'pid.txt');
fs.writeFileSync(helper, `import os, time\nfrom pathlib import Path\nPath(${JSON.stringify(pidFile.replaceAll('\\', '/'))}).write_text(str(os.getpid()))\ntime.sleep(30)\n`);
const waiting = new CustomSpeech({}, () => false, helper);
const abort = new AbortController();
const pending = waiting.speak({ id: 'cancel-tree', text: '取消' }, service.settings(), abort.signal, () => assert.fail('No audio after cancellation'));
for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 100));
assert.ok(fs.existsSync(pidFile), 'Python started'); const pid = Number(fs.readFileSync(pidFile, 'utf8'));
abort.abort(); await assert.rejects(pending, /取消/);
if (process.platform === 'win32') {
  const processes = execFileSync(path.join(process.env.SystemRoot, 'System32/tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  assert.equal(processes.includes(`"${pid}"`), false, 'venv child process exits as well as its launcher');
} else { assert.throws(() => process.kill(pid, 0)); }
// Actual model initialization is also cancellable, with no late PCM emission.
const cancelled = service.speak(1, { id: 'cancel-model', text: '这段语音应该被取消，不应播报。' }, () => assert.fail('No audio after cancellation'));
setTimeout(() => service.cancel(1, 'cancel-model'), 1800);
await assert.rejects(cancelled, { name: 'VoiceCancelledError' });
console.log('Local Qwen metadata, real PCM, service routing, cancellation and Python process cleanup passed. User settings unchanged.');

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as i18n from '@cardbush/platform/i18n';

const exports = {};
new Function('exports', 'require', ts.transpileModule(readFileSync('src/features/voice/microphone.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(exports, () => i18n);
const { openMicrophone } = exports;
async function withDevices(getUserMedia, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia } } });
  try { await run(); } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator;
  }
}
test('default acquisition follows the current system input without mandatory device or format constraints', async () => {
  const calls = []; let systemInput = {};
  await withDevices(async options => { calls.push(options); return systemInput; }, async () => {
    assert.equal(await openMicrophone(), systemInput);
    systemInput = {}; assert.equal(await openMicrophone('default'), systemInput);
  });
  for (const { audio, video } of calls) {
    assert.equal(video, false); assert.equal(audio.deviceId, undefined); assert.equal(audio.sampleRate, undefined);
    for (const value of Object.values(audio)) assert.ok('ideal' in value);
  }
});
test('an available explicit microphone remains selected', async () => {
  const calls = [], stream = {};
  await withDevices(async options => { calls.push(options); return stream; }, async () => assert.equal(await openMicrophone('headset'), stream));
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].audio.deviceId, { exact: 'headset' });
});
for (const name of ['NotFoundError', 'OverconstrainedError', 'NotReadableError', 'AbortError', 'NotSupportedError']) {
  test(`${name} falls back once to the system input without format constraints`, async () => {
    const calls = [], stream = {};
    await withDevices(async options => { calls.push(options); if (calls.length === 1) throw new DOMException('unavailable', name); return stream; },
      async () => assert.equal(await openMicrophone('old-monitor-headset'), stream));
    assert.equal(calls.length, 2); assert.deepEqual(calls[1], { audio: true, video: false });
  });
}
for (const name of ['NotAllowedError', 'SecurityError']) {
  test(`${name} never retries or bypasses microphone permission`, async () => {
    let calls = 0;
    await withDevices(async () => { calls++; throw new DOMException('denied', name); },
      async () => assert.rejects(openMicrophone('headset'), { name }));
    assert.equal(calls, 1);
  });
}
test('unavailable system input has a bounded failure and cancelled acquisition never falls back', async () => {
  let calls = 0;
  await withDevices(async () => { calls++; throw new DOMException('missing', 'NotFoundError'); }, async () => {
    await assert.rejects(openMicrophone(), { message: i18n.uiText()('voiceAudio.systemMicrophoneUnavailable') });
    assert.equal(calls, 2);
    await assert.rejects(openMicrophone('headset', () => true), { name: 'NotFoundError' });
    assert.equal(calls, 3);
  });
});

const source = readFileSync('public/voice/realtime-capture-worklet.js', 'utf8');
function worklet(rate) {
  let Processor; const messages = [];
  vm.runInNewContext(source, { sampleRate: rate, AudioWorkletProcessor: class {
    constructor() { this.port = { postMessage(value) { messages.push(typeof value === 'string' ? value : new Int16Array(value).slice()); } }; }
  }, registerProcessor(_name, value) { Processor = value; } });
  const node = new Processor();
  return { messages, enable(value) { node.port.onmessage({ data: value }); },
    feed(channels, size = 128) { for (let i = 0; i < channels[0].length; i += size) node.process([channels.map(channel => channel.subarray(i, i + size))]); },
    flush() { node.port.onmessage({ data: 'flush' }); return Int16Array.from(messages.filter(value => typeof value !== 'string').flatMap(value => [...value])); } };
}
const sine = (rate, frequency, length = rate) => Float32Array.from({ length }, (_, i) => .5 * Math.sin(2 * Math.PI * frequency * i / rate));
const rms = samples => Math.sqrt(samples.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / samples.length);
for (const rate of [16000, 44100, 48000, 96000]) {
  test(`${rate} Hz capture preserves duration, pitch and continuity in 16 kHz packets`, () => {
    const first = worklet(rate), second = worklet(rate), input = sine(rate, 1000, rate + 137);
    first.enable(true); second.enable(true); first.feed([input]); second.feed([input], 193);
    const pcm = first.flush(); assert.deepEqual(pcm, second.flush());
    assert.equal(pcm.length, Math.floor(input.length * 16000 / rate));
    const frames = first.messages.filter(value => typeof value !== 'string');
    assert.ok(frames.slice(0, -1).every(frame => frame.length === 320)); assert.ok(frames.at(-1).length <= 320);
    assert.equal(first.messages.at(-1), 'flushed');
    const steady = pcm.subarray(160, 16000); assert.ok(rms(steady) > .34 && rms(steady) < .36);
    const crossings = steady.reduce((count, value, i) => count + (i > 0 && value >= 0 && steady[i - 1] < 0 ? 1 : 0), 0);
    assert.ok(Math.abs(crossings * 16000 / steady.length - 1000) < 2, `pitch: ${crossings}`);
  });
}
for (const rate of [44100, 48000, 96000]) {
  test(`${rate} Hz downsampling filters out frequencies above the ASR Nyquist limit`, () => {
    const capture = worklet(rate); capture.enable(true); capture.feed([sine(rate, 12000)]);
    assert.ok(rms(capture.flush().subarray(160)) < .004, 'ultrasonic input must not alias into false speech');
  });
}
test('stereo input includes a microphone delivered on the second channel', () => {
  const capture = worklet(48000); capture.enable(true); capture.feed([new Float32Array(48000), sine(48000, 1000)]);
  const level = rms(capture.flush().subarray(160)); assert.ok(level > .17 && level < .18);
});
test('mute discards buffered samples, resumed capture has no old audio, and repeated enable preserves partial packets', () => {
  const capture = worklet(48000); capture.enable(true); capture.feed([new Float32Array(300).fill(.5)]);
  capture.enable(true); capture.feed([new Float32Array(300).fill(.5)]);
  assert.equal(capture.flush().length, 200, 'repeated enable must not truncate capture');
  const muted = worklet(48000); muted.enable(true); muted.feed([new Float32Array(300).fill(.5)]);
  muted.enable(false); muted.feed([new Float32Array(1200).fill(.5)]); muted.enable(true); muted.feed([new Float32Array(600)]);
  const silence = muted.flush(); assert.equal(silence.length, 200); assert.ok(silence.every(value => value === 0));
});
test('native 16 kHz PCM saturates rather than wrapping loud samples', () => {
  const capture = worklet(16000); capture.enable(true); capture.feed([Float32Array.of(-2, -1, 0, 1, 2)]);
  assert.deepEqual([...capture.flush()], [-32768, -32768, 0, 32767, 32767]);
});

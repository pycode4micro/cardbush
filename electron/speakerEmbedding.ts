import { spawn } from 'node:child_process';
import type { VoiceModelStore } from './voiceModelStore';

export interface SpeakerEmbeddingBackend { extract(audio: ArrayBuffer, signal: AbortSignal): Promise<{ vectors: number[][]; voicedSeconds: number }> }
export class SpeakerAudioUncertain extends Error {}

/** Bounded 16 kHz PCM only. Verify overlapping windows, not a single averaged utterance. */
export function speakerAudioWindows(audio: ArrayBuffer) {
  if (!(audio instanceof ArrayBuffer) || audio.byteLength > 4_000_000) throw Error('声纹验证需要两分钟以内的单声道 WAV。');
  const wav = Buffer.from(audio);
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) !== wav.length - 8) throw Error('声纹验证需要完整的 PCM WAV。');
  let format = false, pcm: Buffer | undefined;
  for (let at = 12; at + 8 <= wav.length;) {
    const size = wav.readUInt32LE(at + 4), start = at + 8, kind = wav.toString('ascii', at, at + 4);
    if (start + size > wav.length) throw Error('声纹录音不完整。');
    if (kind === 'fmt ') {
      if (format || size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt32LE(start + 4) !== 16000 || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) throw Error('声纹验证需要 16 kHz 单声道 PCM。');
      format = true;
    } else if (kind === 'data') { if (pcm) throw Error('重复的音频数据。'); pcm = wav.subarray(start, start + size); }
    at = start + size + size % 2;
  }
  if (!format || !pcm?.length || pcm.length % 2 || pcm.length > 16000 * 2 * 121) throw Error('声纹录音长度无效。');
  const frameBytes = 640, energies: number[] = []; let clipped = 0;
  for (let at = 0; at < pcm.length; at += frameBytes) {
    let sum = 0, count = 0;
    for (let i = at; i + 1 < Math.min(at + frameBytes, pcm.length); i += 2) {
      const value = pcm.readInt16LE(i) / 32768; sum += value * value; count++; if (Math.abs(value) > .99) clipped++;
    }
    energies.push(Math.sqrt(sum / count));
  }
  if (clipped / (pcm.length / 2) > .03) throw new SpeakerAudioUncertain('录音失真，请降低麦克风音量后重试。');
  const sorted = [...energies].sort((a, b) => a - b);
  const floor = Math.max(.004, Math.min(.015, sorted[Math.floor(sorted.length * .2)] * 2));
  const voiced = energies.map(value => value >= floor);
  const voicedSeconds = voiced.filter(Boolean).length * .02;
  if (voicedSeconds < 1.5) throw new SpeakerAudioUncertain('语音太短或过轻，无法确认声纹，请说完整一句。');
  const first = Math.max(0, voiced.indexOf(true) - 6), last = Math.min(voiced.length, voiced.lastIndexOf(true) + 7);
  const samples = pcm.subarray(first * frameBytes, Math.min(pcm.length, last * frameBytes));
  const windows: Buffer[] = [], width = 128000, stride = 64000;
  for (let at = 0;; at += stride) {
    const begin = Math.max(0, Math.min(at, samples.length - width)), end = Math.min(samples.length, begin + width);
    const seconds = voiced.slice(first + Math.floor(begin / frameBytes), first + Math.ceil(end / frameBytes)).filter(Boolean).length * .02;
    if (seconds > 0 && seconds < .75) throw new SpeakerAudioUncertain('部分语音过短或过轻，无法确认声纹。');
    if (seconds >= .75) windows.push(samples.subarray(begin, end));
    if (end === samples.length) break;
  }
  if (!windows.length || windows.length > 64) throw new SpeakerAudioUncertain('无法提取足够的声纹。');
  return { windows, voicedSeconds };
}

export function normalizeSpeakerVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 16 || value.length > 1024 || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) throw Error('声纹特征无效。');
  const norm = Math.sqrt(value.reduce((sum: number, item: number) => sum + item * item, 0));
  if (!Number.isFinite(norm) || norm < 1e-8) throw Error('声纹特征无效。');
  return value.map((item: number) => item / norm);
}
export function speakerSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length) throw Error('声纹模型不匹配，请重新录入。');
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

export class SpeakerEmbedding implements SpeakerEmbeddingBackend {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private store: VoiceModelStore, private executable: string) {}
  extract(audio: ArrayBuffer, signal: AbortSignal) {
    const run = this.serial.catch(() => {}).then(() => this.run(audio, signal)); this.serial = run; return run;
  }
  private async run(audio: ArrayBuffer, signal: AbortSignal) {
    signal.throwIfAborted();
    const { windows, voicedSeconds } = speakerAudioWindows(audio), lease = await this.store.acquire();
    try {
      signal.throwIfAborted();
      const vectors = await new Promise<number[][]>((resolve, reject) => {
        const child = spawn(this.executable, [], { windowsHide: true, shell: false, cwd: lease.directory, signal, timeout: 60_000, stdio: ['pipe', 'pipe', 'ignore'] });
        let output = '', oversized = false;
        child.stdin.on('error', () => {});
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) { oversized = true; child.kill(); } });
        child.once('error', () => reject(Error('本地声纹组件无法启动或已取消，请重新构建或安装 CardBush。')));
        child.once('close', code => {
          try {
            if (code !== 0 || oversized) throw Error();
            const result = JSON.parse(output);
            if (!Array.isArray(result.vectors) || result.vectors.length !== windows.length) throw Error();
            resolve(result.vectors.map(normalizeSpeakerVector));
          } catch { reject(Error('本地声纹验证失败；不会放行这段语音。')); }
        });
        child.stdin.end(JSON.stringify({ directory: lease.directory, clips: windows.map(window => window.toString('base64')) }));
      });
      signal.throwIfAborted();
      return { vectors, voicedSeconds };
    } finally { lease.release(); }
  }
}

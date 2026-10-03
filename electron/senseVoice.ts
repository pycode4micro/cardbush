import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { VoiceSettings } from './voiceTypes';
import type { VoiceModelStore } from './voiceModelStore';

/** Bound attention/memory for long recordings; split near quiet audio, not every fixed syllable. */
export function splitVoiceWave(input: ArrayBuffer): Buffer[] {
  const wav = Buffer.from(input);
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw Error('本地识别需要 PCM WAV 录音。');
  let rate = 0, pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString('ascii', offset, offset + 4), length = wav.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > wav.length) throw Error('录音文件不完整。');
    if (kind === 'fmt ') {
      if (length < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt16LE(start + 14) !== 16) throw Error('本地识别需要单声道 16 位录音。');
      rate = wav.readUInt32LE(start + 4);
    } else if (kind === 'data') pcm = wav.subarray(start, start + length);
    offset = start + length + length % 2;
  }
  if (!pcm?.length || pcm.length % 2 || rate < 8000 || rate > 48000 || pcm.length / (rate * 2) > 121) throw Error('录音长度或采样率无效。');
  const chunks: Buffer[] = [];
  for (let start = 0; start < pcm.length;) {
    let end = Math.min(pcm.length, start + rate * 2 * 25);
    if (end < pcm.length) {
      // Find a 100 ms low-energy window within the last five seconds of this chunk.
      let lowest = Infinity;
      const window = Math.floor(rate / 10) * 2;
      for (let at = start + rate * 2 * 20; at + window <= start + rate * 2 * 25; at += window) {
        let energy = 0;
        for (let i = at; i < at + window; i += 2) energy += pcm.readInt16LE(i) ** 2;
        if (energy < lowest) { lowest = energy; end = at + Math.floor(window / 4) * 2; }
      }
    }
    const data = pcm.subarray(start, end), out = Buffer.alloc(44 + data.length);
    out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28);
    out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(data.length, 40); data.copy(out, 44);
    chunks.push(out); start = end;
  }
  return chunks;
}

export class SenseVoice {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private store: VoiceModelStore, private temporaryRoot: string) {}
  transcribe(audio: ArrayBuffer, config: VoiceSettings, signal: AbortSignal): Promise<{ text: string }> {
    // One CPU inference at a time, shared by owners. Cancellation still applies while queued.
    const run = this.serial.catch(() => {}).then(() => this.recognize(audio, config, signal));
    this.serial = run; return run;
  }
  private async recognize(audio: ArrayBuffer, config: VoiceSettings, signal: AbortSignal) {
    signal.throwIfAborted();
    const clips = splitVoiceWave(audio), lease = await this.store.acquire();
    let temporary: string | undefined;
    try {
      signal.throwIfAborted();
      await fs.promises.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
      temporary = await fs.promises.mkdtemp(path.join(this.temporaryRoot, 'recording-'));
      const files = clips.map((_, i) => path.join(temporary!, `${i}.wav`));
      for (let i = 0; i < clips.length; i++) await fs.promises.writeFile(files[i], clips[i], { mode: 0o600 });
      signal.throwIfAborted();
      const executable = path.join(lease.directory, process.platform === 'win32' ? 'sherpa-onnx-offline.exe' : 'sherpa-onnx-offline');
      const args = [`--tokens=${path.join(lease.directory, 'tokens.txt')}`, `--sense-voice-model=${path.join(lease.directory, 'model.int8.onnx')}`,
        `--sense-voice-language=${config.recognitionLanguage}`, `--sense-voice-use-itn=${config.recognitionFormatting === 'formatted' ? 1 : 0}`, `--num-threads=${Math.min(4, os.availableParallelism())}`, '--provider=cpu', ...files];
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(executable, args, { windowsHide: true, shell: false, cwd: lease.directory, signal, timeout: 85_000,
          env: { ...process.env, ...(process.platform === 'linux' ? { LD_LIBRARY_PATH: lease.directory } : {}) }, stdio: ['ignore', 'pipe', 'ignore'] });
        let text = '', failed = false;
        child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
          text += chunk;
          if (text.length > 1024 * 1024) { failed = true; child.kill(); }
        });
        child.once('error', () => reject(Error(signal.aborted ? '语音识别已取消。' : '本地识别引擎无法启动，请重新安装模型。')));
        child.once('close', code => code === 0 && !failed ? resolve(text) : reject(Error(signal.aborted ? '语音识别已取消。' : '本地语音识别失败或超时。')));
      });
      signal.throwIfAborted();
      const results = output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      if (results.length !== clips.length || results.some(item => typeof item.text !== 'string')) throw Error('本地识别未返回完整结果。');
      const text = results.map(item => item.text.replace(/<\|[^|]*\|>/g, '').trim()).filter(Boolean).join(' ');
      return { text };
    } finally {
      try {
        if (temporary && path.dirname(path.resolve(temporary)) === path.resolve(this.temporaryRoot) && path.basename(temporary).startsWith('recording-')) await fs.promises.rm(temporary, { recursive: true, force: true });
      } finally { lease.release(); }
    }
  }
}

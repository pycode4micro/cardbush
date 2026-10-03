import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { VoiceCapabilities, VoiceSettings, VoiceAudioChunk } from './voiceTypes';

export interface LocalVoiceBackend {
  capabilities(signal: AbortSignal): Promise<VoiceCapabilities>;
  transcribe(audio: ArrayBuffer, config: VoiceSettings, signal: AbortSignal): Promise<{ text: string }>;
  speak(input: { id: string; text: string; voice?: 'female' | 'male' }, config: VoiceSettings, signal: AbortSignal, emit: (chunk: VoiceAudioChunk) => void): Promise<void>;
}

/** Native helpers have no microphone access, network transport, or files containing audio. */
export class WindowsVoice implements LocalVoiceBackend {
  constructor(private executable: string, private platform = process.platform) {}
  async capabilities(signal: AbortSignal): Promise<VoiceCapabilities> {
    if (this.platform !== 'win32') return { available: false, voices: [], recognizers: [], error: '当前平台尚未接入系统语音，可手动选择云端接口。' };
    if (!fs.existsSync(this.executable)) return { available: false, voices: [], recognizers: [], error: '本地语音组件缺失，请重新构建或安装 CardBush。' };
    return this.run({ action: 'capabilities' }, signal) as Promise<VoiceCapabilities>;
  }
  transcribe(audio: ArrayBuffer, config: VoiceSettings, signal: AbortSignal) {
    return this.run({ action: 'transcribe', language: config.language, audio: Buffer.from(audio).toString('base64') }, signal) as Promise<{ text: string }>;
  }
  async speak(input: { id: string; text: string; voice?: 'female' | 'male' }, config: VoiceSettings, signal: AbortSignal, emit: (chunk: VoiceAudioChunk) => void) {
    const gender = input.voice ?? config.voice;
    await this.run({ action: 'speak', language: config.language, gender, text: input.text, speed: config.speed,
      voice: gender === 'female' ? config.systemFemaleVoice : config.systemMaleVoice }, signal,
      (pcm, sampleRate) => emit({ id: input.id, pcm, sampleRate }));
  }
  private run(input: object, signal: AbortSignal, audio?: (pcm: string, sampleRate: number) => void): Promise<unknown> {
    if (this.platform !== 'win32') return Promise.reject(Error('系统语音目前仅支持 Windows。'));
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(Error('语音请求已取消。')); return; }
      const child = spawn(this.executable, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
      let pending = '', total = 0, result: unknown, failure: Error | undefined, settled = false;
      const timer = setTimeout(() => stop(Error('Windows 语音引擎响应超时，请重试。')), 90_000);
      const stop = (error: Error) => { failure = error; child.kill(); };
      const abort = () => stop(Error('语音请求已取消。'));
      signal.addEventListener('abort', abort, { once: true });
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (error || failure) reject(error || failure); else if (!result) reject(Error('Windows 语音组件未返回结果。')); else resolve(result);
      };
      child.on('error', () => finish(Error('无法启动 Windows 本地语音组件，请重新构建或安装 CardBush。')));
      child.stdin.on('error', () => { /* Process exit reports the useful error. */ });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (failure) return;
        total += chunk.length; if (total > 18 * 1024 * 1024) { stop(Error('本地语音返回过大。')); return; }
        pending += chunk;
        for (;;) {
          const end = pending.indexOf('\n'); if (end < 0) break;
          const line = pending.slice(0, end).replace(/^\uFEFF/, ''); pending = pending.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'audio' && typeof event.pcm === 'string' && Number.isInteger(event.sampleRate) && event.sampleRate >= 8000 && event.sampleRate <= 48000) audio?.(event.pcm, event.sampleRate);
            else if (event.type === 'result') result = event;
            else if (event.type === 'error') stop(Error(event.message || 'Windows 本地语音执行失败。'));
          } catch { stop(Error('Windows 本地语音返回格式无效。')); }
        }
      });
      child.on('close', code => finish(code && !failure ? Error('Windows 本地语音组件异常退出。') : undefined));
      child.stdin.end(JSON.stringify(input));
    });
  }
}

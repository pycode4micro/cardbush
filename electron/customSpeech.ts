import { NativeVoiceError, type NativeVoiceMessage } from './voiceUiError';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import type { KokoroVoice } from './kokoroVoice';
import { inspectCustomSpeechModel, validateCustomSpeech } from './customSpeechModel';
import { CUSTOM_SPEECH_TIMEOUT_MS, type VoiceSettings, type VoiceAudioChunk } from './voiceTypes';

const errors: Record<string, NativeVoiceMessage> = {
  dependencies: 'voiceNative.qwenDependencies',
  cuda: 'voiceNative.qwenCudaUnavailable',
  memory: 'voiceNative.qwenMemoryUnavailable',
  model: 'voiceNative.qwenModelLoadFailed',
  synthesis: 'voiceNative.qwenSynthesisFailed',
  audio: 'voiceNative.qwenAudioInvalid',
};

/** Local model adapter. Imported directories stay in place and are never modified or removed. */
export class CustomSpeech {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private kokoro: KokoroVoice, private kokoroAvailable: () => boolean, private helper: string) {}
  inspect(directory: string) { return inspectCustomSpeechModel(directory, this.kokoroAvailable()); }
  validate(settings: VoiceSettings) {
    const config = validateCustomSpeech(settings.customSpeech), model = this.inspect(config.directory);
    if (settings.engine === 'qwen' && model.kind !== 'qwen3-customvoice') throw new NativeVoiceError('voiceNative.qwenCustomVoiceRequired');
    for (const id of [config.femaleVoice || model.defaultFemaleVoice, config.maleVoice || model.defaultMaleVoice]) {
      if (!model.voices.some(voice => voice.id === id)) throw new NativeVoiceError('voiceNative.customVoiceMissing');
    }
    const pythonPath = config.pythonPath || model.suggestedPythonPath;
    if (model.kind === 'qwen3-customvoice') {
      if (!pythonPath) throw new NativeVoiceError('voiceNative.qwenPythonRequired');
      try { if (!fs.statSync(pythonPath).isFile()) throw Error(); }
      catch { throw new NativeVoiceError('voiceNative.customPythonUnavailable'); }
    } else if (!model.runtimeAvailable) throw new NativeVoiceError('voiceNative.customKokoroRequired');
    return { config, model, pythonPath };
  }
  speak(input: { id: string; text: string; voice?: 'female' | 'male' }, settings: VoiceSettings, signal: AbortSignal, emit: (chunk: VoiceAudioChunk) => void) {
    const run = this.serial.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      const { config, model, pythonPath } = this.validate(settings);
      const voice = (input.voice ?? settings.voice) === 'male' ? config.maleVoice || model.defaultMaleVoice : config.femaleVoice || model.defaultFemaleVoice;
      if (model.kind === 'kokoro') return this.kokoro.speakDirectory(input, settings, signal, emit, { directory: model.directory, sid: Number(voice) });
      return this.qwen(pythonPath!, { directory: model.directory, speaker: voice, text: input.text, language: config.language,
        device: config.device, instruction: model.supportsInstructions ? config.instruction : '' }, signal, (pcm, sampleRate) => emit({ id: input.id, pcm, sampleRate }));
    });
    this.serial = run; return run;
  }
  private qwen(python: string, payload: object, signal: AbortSignal, audio: (pcm: string, rate: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      // -I isolates imports from model folders and PYTHONPATH; all weights must already be local.
      const child = spawn(python, ['-I', '-u', this.helper], { cwd: path.dirname(this.helper), windowsHide: true, shell: false,
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1' },
        stdio: ['pipe', 'pipe', 'ignore'] });
      let pending = '', total = 0, bytes = 0, done = false, failure: Error | undefined, settled = false;
      let stopping: Promise<void> | undefined;
      const stop = (key: NativeVoiceMessage) => {
        failure ??= new NativeVoiceError(key);
        if (stopping || child.exitCode !== null) return;
        // Windows venv launchers create a second Python process. Stop the owned tree
        // while its parent is alive, so cancellation also releases model memory.
        stopping = process.platform === 'win32' && child.pid ? new Promise<void>(resolve => {
          execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 5000 }, error => { if (error) child.kill(); resolve(); });
        }) : Promise.resolve().then(() => { child.kill(); });
      };
      const abort = () => stop('voiceNative.synthesisCancelled');
      const timer = setTimeout(() => stop('voiceNative.customSpeechTimeout'), CUSTOM_SPEECH_TIMEOUT_MS);
      signal.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (failure || signal.aborted) return;
        total += chunk.length; pending += chunk;
        if (total > 18 * 1024 * 1024 || pending.length > 256 * 1024) { stop('voiceNative.localOutputTooLarge'); return; }
        for (;;) {
          const end = pending.indexOf('\n'); if (end < 0) break;
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          // Libraries can write startup notices; only our helper's framed events carry audio.
          if (!line.startsWith('{')) continue;
          try {
            const event = JSON.parse(line); if (event.cardbush_tts !== 1) continue;
            if (event.type === 'error') { stop(typeof event.code === 'string' && Object.hasOwn(errors, event.code) ? errors[event.code] : errors.synthesis); break; }
            if (event.type === 'done') { done = true; continue; }
            if (event.type !== 'audio' || done || event.sampleRate !== 24000 || typeof event.pcm !== 'string' ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.pcm)) throw Error();
            const pcm = Buffer.from(event.pcm, 'base64'); bytes += pcm.length;
            if (!pcm.length || pcm.length % 2 || bytes > 12 * 1024 * 1024) throw Error();
            audio(event.pcm, event.sampleRate);
          } catch { stop('voiceNative.customAudioInvalid'); break; }
        }
      });
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (error || failure) reject(error ?? failure); else resolve();
      };
      child.once('error', () => finish(new NativeVoiceError('voiceNative.customPythonStartFailed')));
      child.once('close', code => { void (stopping ?? Promise.resolve()).then(() => finish(failure ?? (code !== 0 || !done || !bytes ? new NativeVoiceError('voiceNative.customAudioIncomplete') : undefined))); });
      child.stdin.end(JSON.stringify(payload));
    });
  }
}

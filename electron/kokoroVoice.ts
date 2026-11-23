import { NativeVoiceError } from './voiceUiError';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { VoiceModelStore } from './voiceModelStore';
import type { VoiceSettings, VoiceAudioChunk } from './voiceTypes';
import { kokoroModelFile } from './customSpeechModel';

/** Decode only the bounded mono PCM format emitted by the pinned native engine. */
export function kokoroPcm(wav: Buffer) {
  if (wav.length > 12 * 1024 * 1024 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new NativeVoiceError('voiceNative.kokoroAudioInvalid');
  let valid = false, pcm: Buffer | undefined;
  for (let at = 12; at + 8 <= wav.length;) {
    const size = wav.readUInt32LE(at + 4), start = at + 8;
    if (start + size > wav.length) throw new NativeVoiceError('voiceNative.kokoroAudioIncomplete');
    const kind = wav.toString('ascii', at, at + 4);
    if (kind === 'fmt ') valid = size >= 16 && wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 && wav.readUInt32LE(start + 4) === 24000 && wav.readUInt16LE(start + 14) === 16;
    if (kind === 'data') pcm = wav.subarray(start, start + size);
    at = start + size + size % 2;
  }
  if (!valid || !pcm?.length || pcm.length % 2) throw new NativeVoiceError('voiceNative.kokoroPcmRequired');
  return pcm;
}

/** Optional CPU quality mode. No account, cloned voice, auto-download or cloud fallback. */
export class KokoroVoice {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private store: VoiceModelStore, private temporaryRoot: string) {}
  speak(input: { id: string; text: string; voice?: 'female' | 'male' }, config: VoiceSettings, signal: AbortSignal, emit: (chunk: VoiceAudioChunk) => void): Promise<void> {
    const run = this.serial.catch(() => {}).then(() => this.synthesize(input, config, signal, emit));
    this.serial = run; return run;
  }
  speakDirectory(input: { id: string; text: string; voice?: 'female' | 'male' }, config: VoiceSettings, signal: AbortSignal,
    emit: (chunk: VoiceAudioChunk) => void, model: { directory: string; sid: number }) {
    const run = this.serial.catch(() => {}).then(() => this.synthesize(input, config, signal, emit, model));
    this.serial = run; return run;
  }
  private async synthesize(input: { id: string; text: string; voice?: 'female' | 'male' }, config: VoiceSettings, signal: AbortSignal, emit: (chunk: VoiceAudioChunk) => void,
    custom?: { directory: string; sid: number }) {
    signal.throwIfAborted();
    const lease = await this.store.acquire(); let temporary: string | undefined;
    try {
      signal.throwIfAborted();
      await fs.promises.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
      temporary = await fs.promises.mkdtemp(path.join(this.temporaryRoot, 'speech-'));
      const output = path.join(temporary, 'speech.wav'), file = (name: string) => path.join(custom?.directory ?? lease.directory, name);
      const sid = custom?.sid ?? ((input.voice ?? config.voice) === 'male' ? config.kokoroMaleVoice ?? 58 : config.kokoroFemaleVoice ?? 3);
      // Delivery controls phrase grouping in the renderer, never the chosen rate.
      // In particular, 1x must stay the model's natural speed for every voice.
      const speed = config.speed;
      const args = [`--kokoro-model=${file(custom ? kokoroModelFile(custom.directory) : 'model.int8.onnx')}`, `--kokoro-voices=${file('voices.bin')}`,
        `--kokoro-tokens=${file('tokens.txt')}`, `--kokoro-data-dir=${file('espeak-ng-data')}`,
        `--kokoro-lexicon=${file('lexicon-us-en.txt')},${file('lexicon-zh.txt')}`,
        `--tts-rule-fsts=${file('date-zh.fst')},${file('number-zh.fst')},${file('phone-zh.fst')}`,
        `--num-threads=${Math.min(2, os.availableParallelism())}`, '--provider=cpu', `--sid=${sid}`, `--speed=${speed}`,
        `--output-filename=${output}`, ' ' + input.text.replace(/\x00/g, '')];
      await new Promise<void>((resolve, reject) => {
        // No shell and no native transcript logging. A leading space prevents text from being parsed as options.
        // Execute only our pinned runtime, never binaries in an imported model folder.
        const child = spawn(path.join(lease.directory, 'sherpa-onnx-offline-tts.exe'), args, { windowsHide: true, shell: false,
          cwd: lease.directory, signal, timeout: 85_000, stdio: 'ignore' });
        let failure: Error | undefined;
        child.once('error', () => { failure = new NativeVoiceError(signal.aborted ? 'voiceNative.synthesisCancelled' : 'voiceNative.kokoroStartFailed'); });
        child.once('close', code => failure ? reject(failure) : code === 0 ? resolve() : reject(new NativeVoiceError(signal.aborted ? 'voiceNative.synthesisCancelled' : 'voiceNative.kokoroSynthesisFailed')));
      });
      signal.throwIfAborted();
      if ((await fs.promises.stat(output)).size > 12 * 1024 * 1024) throw new NativeVoiceError('voiceNative.replyTooLong');
      const pcm = kokoroPcm(await fs.promises.readFile(output));
      for (let at = 0; at < pcm.length; at += 48000) {
        signal.throwIfAborted(); emit({ id: input.id, pcm: pcm.subarray(at, at + 48000).toString('base64'), sampleRate: 24000 });
      }
    } finally {
      try {
        if (temporary && path.dirname(path.resolve(temporary)) === path.resolve(this.temporaryRoot) && path.basename(temporary).startsWith('speech-')) await fs.promises.rm(temporary, { recursive: true, force: true });
      } finally { lease.release(); }
    }
  }
}

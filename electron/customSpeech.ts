import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import type { KokoroVoice } from './kokoroVoice';
import { inspectCustomSpeechModel, validateCustomSpeech } from './customSpeechModel';
import { CUSTOM_SPEECH_TIMEOUT_MS, type VoiceSettings, type VoiceAudioChunk } from './voiceTypes';

const errors: Record<string, string> = {
  dependencies: '所选 Python 环境缺少 Qwen3-TTS 依赖，请先按官方说明安装 qwen-tts 和 PyTorch。',
  cuda: '所选 Python 环境无法使用 CUDA，请检查 GPU 运行库或选择 CPU。',
  memory: '显存或内存不足，请关闭其他模型任务，或选择更小的兼容模型。',
  model: 'Qwen 模型加载失败，请检查目录是否完整、模型版本和运行依赖是否兼容。',
  synthesis: 'Qwen 语音合成失败，请检查所选音色、模型和运行依赖。',
  audio: '模型没有返回有效的单声道 PCM 音频。',
};

/** Local model adapter. Imported directories stay in place and are never modified or removed. */
export class CustomSpeech {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private kokoro: KokoroVoice, private kokoroAvailable: () => boolean, private helper: string) {}
  inspect(directory: string) { return inspectCustomSpeechModel(directory, this.kokoroAvailable()); }
  validate(settings: VoiceSettings) {
    const config = validateCustomSpeech(settings.customSpeech), model = this.inspect(config.directory);
    if (settings.engine === 'qwen' && model.kind !== 'qwen3-customvoice') throw Error('Qwen 朗读需要 Qwen3-TTS CustomVoice 模型目录，请重新选择。');
    for (const id of [config.femaleVoice || model.defaultFemaleVoice, config.maleVoice || model.defaultMaleVoice]) {
      if (!model.voices.some(voice => voice.id === id)) throw Error('保存的音色不在当前模型中，请重新选择。');
    }
    const pythonPath = config.pythonPath || model.suggestedPythonPath;
    if (model.kind === 'qwen3-customvoice') {
      if (!pythonPath) throw Error('请选择已安装 qwen-tts 的 Python 解释器。');
      try { if (!fs.statSync(pythonPath).isFile()) throw Error(); }
      catch { throw Error('Python 解释器不存在或不可访问，请重新选择。'); }
    } else if (!model.runtimeAvailable) throw Error('自定义 Kokoro 需要本地运行组件，请先安装下方的 Kokoro 可选组件。');
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
      const stop = (message: string) => {
        failure ??= Error(message);
        if (stopping || child.exitCode !== null) return;
        // Windows venv launchers create a second Python process. Stop the owned tree
        // while its parent is alive, so cancellation also releases model memory.
        stopping = process.platform === 'win32' && child.pid ? new Promise<void>(resolve => {
          execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 5000 }, error => { if (error) child.kill(); resolve(); });
        }) : Promise.resolve().then(() => { child.kill(); });
      };
      const abort = () => stop('语音合成已取消。');
      const timer = setTimeout(() => stop('本地模型合成超时，请缩短文本或检查计算设备。'), CUSTOM_SPEECH_TIMEOUT_MS);
      signal.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (failure || signal.aborted) return;
        total += chunk.length; pending += chunk;
        if (total > 18 * 1024 * 1024 || pending.length > 256 * 1024) { stop('本地语音返回过大。'); return; }
        for (;;) {
          const end = pending.indexOf('\n'); if (end < 0) break;
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          // Libraries can write startup notices; only our helper's framed events carry audio.
          if (!line.startsWith('{')) continue;
          try {
            const event = JSON.parse(line); if (event.cardbush_tts !== 1) continue;
            if (event.type === 'error') { stop(errors[event.code] ?? errors.synthesis); break; }
            if (event.type === 'done') { done = true; continue; }
            if (event.type !== 'audio' || done || event.sampleRate !== 24000 || typeof event.pcm !== 'string' ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.pcm)) throw Error();
            const pcm = Buffer.from(event.pcm, 'base64'); bytes += pcm.length;
            if (!pcm.length || pcm.length % 2 || bytes > 12 * 1024 * 1024) throw Error();
            audio(event.pcm, event.sampleRate);
          } catch { stop('本地语音返回格式无效。'); break; }
        }
      });
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (error || failure) reject(error ?? failure); else resolve();
      };
      child.once('error', () => finish(Error('Python 无法启动，请重新选择可用的解释器。')));
      child.once('close', code => { void (stopping ?? Promise.resolve()).then(() => finish(failure ?? (code !== 0 || !done || !bytes ? Error('本地模型未返回完整音频，请检查模型及 Python 环境。') : undefined))); });
      child.stdin.end(JSON.stringify(payload));
    });
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { defaultVoiceSettings, type VoiceSettings, type VoiceSettingsInput, type VoiceAudioChunk } from './voiceTypes';
import type { LocalVoiceBackend } from './windowsVoice';

interface Dependencies {
  local?: LocalVoiceBackend;
  recognition?: Pick<LocalVoiceBackend, 'transcribe'>;
  speech?: Pick<LocalVoiceBackend, 'speak'>;
  fetch: typeof fetch;
  encrypt(value: string): string;
  decrypt(value: string): string;
}
const MAX_AUDIO = 12 * 1024 * 1024;
const textField = (value: unknown, max = 200): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\x00]/.test(value)) throw Error('Invalid voice configuration.');
  return value.trim();
};
export function validateVoiceSettings(input: VoiceSettingsInput): Omit<VoiceSettings, 'hasApiKey'> {
  const engine = input.engine ?? 'system', language = input.language ?? 'zh-CN';
  const recognitionEngine = input.recognitionEngine ?? (engine === 'kokoro' ? 'system' : engine), recognitionLanguage = input.recognitionLanguage ?? 'auto';
  const recognitionFormatting = input.recognitionFormatting ?? 'verbatim';
  if (!['verbatim', 'formatted'].includes(recognitionFormatting)) throw Error('Invalid recognition formatting.');
  if (!['system', 'sensevoice', 'cloud'].includes(recognitionEngine) || !['auto', 'zh', 'en'].includes(recognitionLanguage)) throw Error('Invalid recognition settings.');
  if (!['system', 'kokoro', 'cloud'].includes(engine) || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) throw Error('Invalid voice engine or language.');
  const baseUrl = textField(input.baseUrl, 2048).replace(/\/+$/, ''), url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw Error('语音服务需要 HTTPS 地址，本机服务可使用 HTTP。');
  }
  if (!['female', 'male'].includes(input.voice) || !Number.isFinite(input.speed) || input.speed < .5 || input.speed > 2) throw Error('Invalid voice selection or speed.');
  return { engine, recognitionEngine, recognitionLanguage, recognitionFormatting, microphoneId: input.microphoneId ? textField(input.microphoneId, 512) : '', language, systemFemaleVoice: input.systemFemaleVoice ? textField(input.systemFemaleVoice) : '',
    systemMaleVoice: input.systemMaleVoice ? textField(input.systemMaleVoice) : '', baseUrl, transcriptionModel: textField(input.transcriptionModel), speechModel: textField(input.speechModel),
    femaleVoice: textField(input.femaleVoice), maleVoice: textField(input.maleVoice), voice: input.voice, speed: input.speed };
}

/** Credentials never return to the renderer. Audio is bounded; local model scratch files are owned by its backend. */
export class VoiceService {
  private jobs = new Map<string, AbortController>();
  constructor(private file: string, private deps: Dependencies) {}
  private read(): { settings: VoiceSettings; secret: string } {
    if (!fs.existsSync(this.file)) return { settings: { ...defaultVoiceSettings }, secret: '' };
    const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    // Preserve an explicitly configured legacy cloud account. New installations default to Windows.
    return { settings: { ...validateVoiceSettings({ ...saved, engine: saved.engine ?? (saved.secret ? 'cloud' : 'system') }), hasApiKey: Boolean(saved.secret) }, secret: saved.secret || '' };
  }
  settings(): VoiceSettings { return this.read().settings; }
  async capabilities() {
    if (!this.deps.local) return { available: false, voices: [], recognizers: [], error: '本地语音组件不可用。' };
    return this.deps.local.capabilities(AbortSignal.timeout(15_000));
  }
  save(input: VoiceSettingsInput): VoiceSettings {
    const next = validateVoiceSettings(input), old = this.read();
    // A retained key must never follow a changed destination silently.
    if (next.baseUrl !== old.settings.baseUrl && input.apiKey === undefined && old.secret) throw Error('更换语音服务地址时，请重新填写 API Key。');
    const secret = input.apiKey === undefined ? old.secret : input.apiKey.trim() ? this.deps.encrypt(textField(input.apiKey, 4096)) : '';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...next, secret }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return { ...next, hasApiKey: Boolean(secret) };
  }
  cancel(owner: number, id: string) { this.jobs.get(`${owner}:${id}`)?.abort('voice-cancelled'); }
  cancelOwner(owner: number) { for (const [key, job] of this.jobs) if (key.startsWith(`${owner}:`)) job.abort('voice-cancelled'); }
  private async request<T>(owner: number, id: string, operation: 'transcribe' | 'speak', run: (settings: VoiceSettings, key: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw Error('Invalid audio request ID.');
    const jobId = `${owner}:${id}`;
    if (this.jobs.has(jobId) || [...this.jobs.keys()].filter(key => key.startsWith(`${owner}:`)).length >= 4) throw Error('语音请求过多，请稍后重试。');
    const saved = this.read();
    const engine = operation === 'transcribe' ? saved.settings.recognitionEngine : saved.settings.engine;
    if (engine === 'cloud' && !saved.secret) throw Error('请先在「设置 → 语音」配置云端 API Key，或选择本地语音。');
    if (engine === 'system' && !this.deps.local) throw Error('本地语音组件不可用。');
    if (engine === 'sensevoice' && !this.deps.recognition) throw Error('请先安装本地识别模型。');
    if (engine === 'kokoro' && !this.deps.speech) throw Error('请先安装本地自然音色。');
    const controller = new AbortController(); this.jobs.set(jobId, controller);
    const timer = setTimeout(() => controller.abort(), 90_000);
    try { return await run(saved.settings, engine === 'cloud' ? this.deps.decrypt(saved.secret) : '', controller.signal); }
    catch (error) {
      if (controller.signal.aborted && controller.signal.reason === 'voice-cancelled') throw Object.assign(Error('语音请求已取消。'), { name: 'VoiceCancelledError' });
      throw error;
    }
    finally { clearTimeout(timer); this.jobs.delete(jobId); }
  }
  async transcribe(owner: number, input: { id: string; audio: ArrayBuffer; mimeType: string; language?: string }) {
    const mime = input.mimeType.split(';')[0];
    const extension = ({ 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/wav': 'wav' } as Record<string, string>)[mime];
    if (!extension || !(input.audio instanceof ArrayBuffer) || !input.audio.byteLength || input.audio.byteLength > MAX_AUDIO) throw Error('录音格式不支持或超过 12 MB，请缩短录音。');
    return this.request(owner, input.id, 'transcribe', async (config, key, signal) => {
      if (config.recognitionEngine !== 'cloud') {
        if (mime !== 'audio/wav') throw Error('本地语音识别需要 WAV 录音，请重新开始录音。');
        const result = await (config.recognitionEngine === 'sensevoice' ? this.deps.recognition! : this.deps.local!).transcribe(input.audio, config, signal);
        return { text: result.text.trim() };
      }
      const body = new FormData();
      body.set('model', config.transcriptionModel); body.set('response_format', 'json');
      body.set('file', new Blob([input.audio], { type: mime }), `recording.${extension}`);
      if (config.recognitionLanguage !== 'auto') body.set('language', config.recognitionLanguage);
      const response = await this.deps.fetch(`${config.baseUrl}/audio/transcriptions`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body, signal, redirect: 'error',
      });
      await checkResponse(response);
      const bytes = await boundedBody(response, 256 * 1024);
      const result = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (typeof result.text !== 'string') throw Error('语音服务未返回转写文本。');
      return { text: result.text.trim() as string };
    });
  }
  async speak(owner: number, input: { id: string; text: string; voice?: 'female' | 'male' }, emit: (chunk: VoiceAudioChunk) => void) {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 3000 || input.voice && !['female', 'male'].includes(input.voice)) throw Error('Invalid speech request.');
    return this.request(owner, input.id, 'speak', async (config, key, signal) => {
      if (config.engine === 'kokoro') return this.deps.speech!.speak(input, config, signal, emit);
      if (config.engine === 'system') return this.deps.local!.speak(input, config, signal, emit);
      const voice = (input.voice ?? config.voice) === 'male' ? config.maleVoice : config.femaleVoice;
      const response = await this.deps.fetch(`${config.baseUrl}/audio/speech`, { method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal, redirect: 'error',
        body: JSON.stringify({ model: config.speechModel, input: input.text, voice, speed: config.speed, response_format: 'pcm' }),
      });
      await checkResponse(response);
      if (!response.body || /json|text\/|html/.test(response.headers.get('content-type') ?? '')) throw Error('语音服务没有返回 PCM 音频。');
      const reader = response.body.getReader(); let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          signal.throwIfAborted(); size += value.byteLength;
          if (size > MAX_AUDIO) throw Error('语音回复过长。');
          emit({ id: input.id, pcm: Buffer.from(value).toString('base64'), sampleRate: 24_000 });
        }
        if (!size) throw Error('语音服务返回了空音频。');
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    });
  }
}
async function checkResponse(response: Response) {
  if (response.ok) return;
  await response.body?.cancel();
  // Do not forward provider bodies, URLs, or credentials into renderer errors/logs.
  throw Error(response.status === 401 || response.status === 403 ? '语音服务授权失败，请检查 API Key 和模型权限。' :
    response.status === 429 ? '语音服务额度不足或请求过于频繁。' : `语音服务请求失败（HTTP ${response.status}）。`);
}
async function boundedBody(response: Response, limit: number) {
  if (!response.body) throw Error('语音服务返回为空。');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw Error('转写返回过大。'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

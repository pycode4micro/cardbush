import fs from 'node:fs';
import path from 'node:path';
import { defaultRealtimeVoiceSettings, type RealtimeVoiceSettings, type RealtimeVoiceSettingsInput } from './realtimeVoiceTypes';
import { realtimeVoiceCatalog } from './realtimeVoiceCatalog';

type Provider = RealtimeVoiceSettings['provider'];
type Profile = typeof realtimeVoiceCatalog.volcengine.defaults & { secret: string };
type Saved = { provider: Provider; mode: RealtimeVoiceSettings['mode']; instructions: string; profiles: Partial<Record<Provider, Profile>> };
const legacyPrompt = '你是 CardBush 的语音伙伴。以成熟、温和、可靠的语气自然交流，使用正常语速，给用户留出思考和停顿的时间。跟随用户使用中文或英文。';
export class RealtimeVoiceConfiguration {
  constructor(private file: string, private encrypt: (value: string) => string) {}
  private read(): Saved {
    if (!fs.existsSync(this.file)) return { ...defaultRealtimeVoiceSettings, profiles: {} };
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!Object.hasOwn(realtimeVoiceCatalog, data.provider)) throw Error('Invalid realtime provider.');
    const instructions = data.instructions === legacyPrompt ? defaultRealtimeVoiceSettings.instructions : data.instructions;
    // Migrate the original single-provider file in memory; write only on Save.
    return { provider: data.provider, mode: data.mode, instructions, profiles: data.version === 2 ? data.profiles : {
      [data.provider]: { ...realtimeVoiceCatalog[data.provider as Provider].defaults,
        femaleVoice: data.femaleVoice, maleVoice: data.maleVoice, secret: data.secret || '' },
    } };
  }
  current() {
    const data = this.read(), profile = data.profiles[data.provider];
    const profiles = Object.fromEntries(Object.entries(data.profiles).map(([key, { secret, ...rest }]) => [key, { ...rest, hasApiKey: Boolean(secret) }]));
    const { secret = '', ...connection } = profile ?? { ...realtimeVoiceCatalog[data.provider].defaults, secret: '' };
    return { secret, settings: { mode: data.mode, instructions: data.instructions, provider: data.provider, ...connection,
      hasApiKey: Boolean(secret), profiles } satisfies RealtimeVoiceSettings };
  }
  save(input: RealtimeVoiceSettingsInput) {
    if (!input || !['realtime', 'chained'].includes(input.mode) || !Object.hasOwn(realtimeVoiceCatalog, input.provider)) throw Error('Invalid realtime provider.');
    if (typeof input.instructions !== 'string' || input.instructions.length > 2000 || input.instructions.includes('\0')) throw Error('语音提示词最多 2000 个字符。');
    for (const voice of [input.femaleVoice, input.maleVoice]) if (typeof voice !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(voice)) throw Error('Invalid realtime voice ID.');
    const defaults = realtimeVoiceCatalog[input.provider].defaults;
    const model = input.model ?? defaults.model;
    if (typeof model !== 'string' || !/^[a-zA-Z0-9_./:-]{1,200}$/.test(model)) throw Error('请填写有效的语音模型 ID。');
    let endpoint = defaults.endpoint;
    if (input.provider === 'cardbush') {
      let url: URL;
      try { url = new URL(input.endpoint ?? ''); } catch { throw Error('请填写 CardBush Realtime 兼容服务的 WebSocket 地址。'); }
      if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
        throw Error('使用 wss:// 地址；仅本机回环允许 ws://。密钥请填写在 API Key 中，不放入地址。');
      }
      endpoint = url.href;
    }
    const data = this.read(), previous = data.profiles[input.provider];
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n\0]/.test(input.apiKey))) throw Error('Invalid API Key.');
    const secret = input.apiKey !== undefined ? input.apiKey.trim() ? this.encrypt(input.apiKey.trim()) : '' :
      previous?.endpoint === endpoint ? previous.secret : '';
    data.profiles[input.provider] = { model, endpoint, femaleVoice: input.femaleVoice, maleVoice: input.maleVoice, secret };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ ...data, version: 2, provider: input.provider, mode: input.mode, instructions: input.instructions }), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    return this.current().settings;
  }
}

import { NativeVoiceError } from './voiceUiError';
import fs from 'node:fs';
import path from 'node:path';
import { defaultRealtimeVoiceSettings, type RealtimeVoiceSettings, type RealtimeVoiceSettingsInput, type RealtimeVoiceConnectionProfile, type RealtimeVoiceSelection } from './realtimeVoiceTypes';
import { realtimeVoiceOptions, validRealtimeVoiceId } from './realtimeVoiceOptions';
import { realtimeVoiceCatalog } from './realtimeVoiceCatalog';
import { uiText } from '@cardbush/platform/i18n';

type Provider = RealtimeVoiceSettings['provider'];
type Profile = Omit<RealtimeVoiceConnectionProfile,'hasApiKey'> & { secret: string };
type Saved = { provider: Provider; mode: RealtimeVoiceSettings['mode']; instructions: string; profiles: Partial<Record<Provider, Profile>> };
const legacyPrompt = '你是 CardBush 的语音伙伴。以成熟、温和、可靠的语气自然交流，使用正常语速，给用户留出思考和停顿的时间。跟随用户使用中文或英文。';
export class RealtimeVoiceConfiguration {
  constructor(private file: string, private encrypt: (value: string) => string, private language: () => string = () => 'en') {}
  private read(): Saved {
    if (!fs.existsSync(this.file)) return { ...defaultRealtimeVoiceSettings, profiles: {} };
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!Object.hasOwn(realtimeVoiceCatalog, data.provider)) throw new NativeVoiceError('voiceNative.invalidRealtimeProvider');
    const instructions = data.instructions === legacyPrompt ? defaultRealtimeVoiceSettings.instructions : data.instructions;
    // Migrate the original single-provider file in memory; write only on Save.
    return { provider: data.provider, mode: data.mode, instructions, profiles: data.version === 2 ? data.profiles : {
      [data.provider]: { ...realtimeVoiceCatalog[data.provider as Provider].defaults,
        femaleVoice: data.femaleVoice, maleVoice: data.maleVoice, secret: data.secret || '' },
    } };
  }
  current(provider?: Provider) {
    const data = this.read();
    if(provider)data.provider=provider;
    const profile = data.profiles[data.provider];
    const profiles = Object.fromEntries(Object.entries(data.profiles).map(([key, { secret, ...rest }]) => [key, { ...rest, hasApiKey: Boolean(secret) }]));
    const { secret = '', ...connection } = profile ?? { ...realtimeVoiceCatalog[data.provider].defaults, secret: '' };
    return { secret, settings: { mode: data.mode, instructions: data.instructions, provider: data.provider, ...connection,
      hasApiKey: Boolean(secret), profiles } satisfies RealtimeVoiceSettings };
  }
  save(input: RealtimeVoiceSettingsInput) {
    if (!input || !['realtime', 'chained'].includes(input.mode) || !Object.hasOwn(realtimeVoiceCatalog, input.provider)) throw new NativeVoiceError('voiceNative.invalidRealtimeProvider');
    if (typeof input.instructions !== 'string' || input.instructions.length > 2000 || input.instructions.includes('\0')) throw new NativeVoiceError('voiceNative.instructionsLimit');
    for (const voice of [input.femaleVoice, input.maleVoice]) if (typeof voice !== 'string' || !voice.trim() || !/^[a-zA-Z0-9_.: -]{1,200}$/.test(voice)) throw new NativeVoiceError('voiceNative.invalidRealtimeVoice');
    const defaults = realtimeVoiceCatalog[input.provider].defaults;
    const model = input.model ?? defaults.model;
    if (typeof model !== 'string' || !/^[a-zA-Z0-9_./:-]{1,200}$/.test(model)) throw new NativeVoiceError('voiceNative.invalidRealtimeModel');
    let endpoint = defaults.endpoint;
    if (input.provider === 'qwen') {
      const error=()=>Error(uiText(this.language())('realtimeVoice.qwenEndpointRequired'));
      let url: URL;
      try { url=new URL(input.endpoint??''); } catch { throw error(); }
      // Native Alibaba Cloud endpoints only; arbitrary services use the bridge.
      if (url.protocol!=='wss:' || url.username || url.password || url.search || url.hash || url.port ||
          url.pathname!=='/api-ws/v1/realtime' ||
          !/^[a-zA-Z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname)) throw error();
      endpoint=url.href;
    } else if (input.provider === 'cardbush') {
      let url: URL;
      try { url = new URL(input.endpoint ?? ''); } catch { throw new NativeVoiceError('voiceNative.bridgeEndpointRequired'); }
      if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
        throw new NativeVoiceError('voiceNative.bridgeEndpointSecure');
      }
      endpoint = url.href;
    }
    const data = this.read(), previous = data.profiles[input.provider];
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n\0]/.test(input.apiKey))) throw new NativeVoiceError('voiceNative.invalidRealtimeApiKey');
    const secret = input.apiKey !== undefined ? input.apiKey.trim() ? this.encrypt(input.apiKey.trim()) : '' :
      previous?.endpoint === endpoint ? previous.secret : '';
    const selection = this.validateVoices({...input, voiceId:input.voiceId ?? previous?.voiceId, customVoices:input.customVoices ?? previous?.customVoices});
    data.profiles[input.provider] = { model, endpoint, femaleVoice: input.femaleVoice, maleVoice: input.maleVoice, ...selection, secret };
    this.write({...data,provider:input.provider,mode:input.mode,instructions:input.instructions});
    return this.current().settings;
  }
  /** Change a provider's voice without copying credentials or switching providers. */
  saveVoices(input: RealtimeVoiceSelection) {
    if(!input || !Object.hasOwn(realtimeVoiceCatalog,input.provider)) throw new NativeVoiceError('voiceNative.invalidRealtimeProvider');
    const data=this.read(), profile=data.profiles[input.provider] ?? {...realtimeVoiceCatalog[input.provider].defaults,secret:''};
    const selection=this.validateVoices({...profile,provider:input.provider,voiceId:input.voiceId,customVoices:input.customVoices ?? profile.customVoices});
    data.profiles[input.provider]={...profile,...selection};
    this.write(data);
    return this.current(input.provider).settings;
  }
  private validateVoices(input: Pick<RealtimeVoiceSettings,'provider'|'femaleVoice'|'maleVoice'|'voiceId'|'customVoices'>) {
    const invalid=()=>Error(uiText(this.language())('realtimeVoiceOptions.invalid'));
    const customVoices=input.customVoices ?? [];
    if(!Array.isArray(customVoices) || customVoices.length>24 || customVoices.some(v=>!v || !validRealtimeVoiceId(v.id) || typeof v.name!=='string' || v.name.length>80 || /[\r\n\0]/.test(v.name)) || new Set(customVoices.map(v=>v.id)).size!==customVoices.length) throw invalid();
    if(input.voiceId!==undefined && (!validRealtimeVoiceId(input.voiceId) || !realtimeVoiceOptions({...input,voiceId:undefined}).some(v=>v.id===input.voiceId))) throw invalid();
    return {voiceId:input.voiceId,customVoices:customVoices.map(({id,name})=>({id,name:name.trim()}))};
  }
  private write(data: Saved) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ ...data, version: 2 }), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
}

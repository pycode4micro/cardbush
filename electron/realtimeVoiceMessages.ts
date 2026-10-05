import type { RealtimeVoiceProvider, ProviderEvent } from './realtimeVoiceProvider';
const str = (value: unknown) => typeof value === 'string' ? value : '';

/** CardBush's canonical JSON messages; native adapters may translate these to vendor frames. */
export const realtimeVoiceMessages: Pick<RealtimeVoiceProvider, 'context' | 'audio' | 'control' | 'results' | 'speak' | 'parse'> = {
  context: items => ({ type: 'conversation.item.create', items: items.map(item => ({ ...(item.id ? { id: item.id } : {}), type: 'message', role: item.role, content: [{ type: 'input_text', text: item.text }] })) }),
  audio: pcm => ({ type: 'input_audio_buffer.append', audio: pcm }),
  control: action => ({ type: ({ mute: 'input_audio_mute.commit', unmute: 'input_audio_unmute.commit', interrupt: 'response.cancel', commit: 'input_audio_buffer.commit', close: 'session.close' })[action] }),
  results: results => ({ type: 'conversation.item.create', items: results.map(result => ({ call_id: result.id, role: 'tool', content: [{ type: 'input_text', text: result.output }] })) }),
  speak: text => ({ type: 'speech_text_buffer.commit', text }),
  parse: event => {
    const type = str(event.type), itemId = str(event.item_id) || str(event.response_id);
    if (type === 'session.created') return [{ type: 'ready' }];
    if (type === 'session.closed') return [{ type: 'closed' }];
    if (type === 'response.canceled') return [{ type: 'interrupted' }];
    if (type === 'response.output_audio.started') return [{ type: 'audio-start' }];
    if (type === 'response.output_audio.done') return [{ type: 'audio-end' }];
    if (type === 'response.output_audio.delta') {
      const pcm = str(event.delta);
      if (!pcm || pcm.length > 700_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(pcm) || Buffer.from(pcm, 'base64').length % 2) throw Error('Invalid realtime audio.');
      return [{ type: 'audio', pcm, sampleRate: 24000 }];
    }
    if (type === 'response.function_call_arguments.done') {
      if (!Array.isArray(event.items) || !event.items.length || event.items.length > 8) throw Error('Invalid realtime tool batch.');
      const calls = event.items.map(item => {
        if (!item || typeof item !== 'object' || !str(item.call_id) || str(item.call_id).length > 200 || typeof item.arguments !== 'string' || item.arguments.length > 16_000) throw Error('Invalid realtime tool call.');
        return { id: item.call_id as string, name: str(item.name), arguments: item.arguments as string };
      });
      if (new Set(calls.map(call => call.id)).size !== calls.length) throw Error('Duplicate realtime call ID.');
      return [{ type: 'tools', calls }];
    }
    if (type === 'conversation.item.input_audio_transcription.failed') return [{ type: 'input-discarded', itemId }];
    if (type === 'error') {
      // Never expose raw vendor error text, which can echo credentials or audio.
      const code = String(event.status_code ?? '').replace(/[^0-9]/g, '').slice(0,12);
      return [{ type: 'error', message: `实时语音请求失败${code ? `（${code}）` : ''}，请检查 API Key、服务开通和网络设置。` }];
    }
    const user = type.startsWith('conversation.item.input_audio_transcription.');
    if (user || type.startsWith('response.output_text.')) {
      const final = type.endsWith('.completed') || type.endsWith('.done');
      const text = str(event.transcript) || str(event.text) || str(event.delta);
      return text || final ? [{ type: 'transcript', role: user ? 'user' : 'assistant', text: text.slice(0,16000), final, itemId } as ProviderEvent] : [];
    }
    return [];
  },
};

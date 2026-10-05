import { useSyncExternalStore } from 'react';
import { Lightbulb } from 'lucide-react';
import { applicationVoiceSession } from '../voice/VoiceConversation';
import './assistant.css';
import { useAssistantWorking } from './assistantProfile';
import { useAssistantAvatar } from './assistantAvatar';

export function AssistantBulb({ size = 19, working = false }: { size?: number; working?: boolean }) {
  const voice = applicationVoiceSession();
  const state = useSyncExternalStore(voice.subscribe, voice.snapshot);
  const backgroundWorking = useAssistantWorking();
  const avatar = useAssistantAvatar();
  const call = state.assistant && state.mode === 'call';
  const phase = call ? state.error ? 'error' : state.phase === 'connecting' ? 'connecting' : state.speaking ? 'speaking' : state.muted ? 'muted' : 'listening' : working || backgroundWorking ? 'working' : 'idle';
  return <span className={`assistant-bulb${avatar ? ' assistant-avatar' : ''}`} data-state={phase} aria-hidden="true" style={{ '--voice-level': Math.max(.15, state.level), width: size, height: size } as React.CSSProperties}>
    {avatar ? <img src={avatar} alt="" width={size} height={size}/> : <Lightbulb size={size} strokeWidth={1.7}/>}
  </span>;
}

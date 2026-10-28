import { uiText } from '../../i18n';
import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import type { RegionConversation } from './InspectorRegionSelection';

export const RegionConversationContext = createContext<((value: RegionConversation | null) => void) | null>(null);

/** Only the active host publishes its sender; retained conversations cannot take over. */
export function usePublishRegionConversation(value: RegionConversation, active: boolean) {
  const publish = useContext(RegionConversationContext);
  const latest = useRef(value); latest.current = value;
  const send = useCallback<RegionConversation['send']>((text) => latest.current.send(text), []);
  const saveImage = useCallback(async (data: string) => {
    if (!latest.current.saveImage) throw Error(uiText()('regionConversationContext.screenshot_upload_is_unavailable'));
    return latest.current.saveImage(data);
  }, []);
  const hasImageUpload = Boolean(value.saveImage);
  const published = useRef<RegionConversation | null>(null);
  useEffect(() => {
    if (!active || !publish) return;
    const prior = published.current;
    if (prior?.scope === value.scope && prior.busy === value.busy && prior.error === value.error && Boolean(prior.saveImage) === hasImageUpload
      && prior.messages.length === value.messages.length && prior.messages.every((message, index) => {
        const next = value.messages[index]; return message.id === next.id && message.role === next.role && message.content === next.content && message.metadata?.promptContext === next.metadata?.promptContext;
      })) return;
    published.current = value;
    publish({ scope: value.scope, busy: value.busy, error: value.error, messages: value.messages, send, ...(hasImageUpload ? { saveImage } : {}) });
  }, [active, publish, value.scope, value.busy, value.error, value.messages, send, saveImage, hasImageUpload]);
  useEffect(() => {
    if (!active || !publish) return;
    return () => { published.current = null; publish(null); };
  }, [active, publish, value.scope]);
}

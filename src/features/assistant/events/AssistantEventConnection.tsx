import { useEffect, useRef, useState } from 'react';
import type { ChatStreamRequest } from '../../../backend/api';
import { eventBackend } from './eventBackend';
import { useAssistantProfile } from '../assistantProfile';
import { useComponents } from '../../components/componentStore';

/** Mounted with the App, so closing the Assistant surface never owns its scheduler. */
export function AssistantEventConnection({ prepare, language, configuration, enabled, floating = false }: {
  prepare(): Promise<ChatStreamRequest>; language: string; configuration: unknown; enabled: boolean; floating?: boolean;
}) {
  const profile = useAssistantProfile(), prepareRef = useRef(prepare), profileRef = useRef(profile);
  prepareRef.current = prepare; profileRef.current = profile;
  const componentCatalog = JSON.stringify(useComponents(enabled && !floating).items.slice(0, 40).map(({id, title}) => ({id, title})));
  const [catalogRevision, setCatalogRevision] = useState(0);
  useEffect(() => {
    if (enabled && floating) return window.cardbushDesktop?.onHomeComponentsChanged?.(() => setCatalogRevision(value => value + 1));
  }, [enabled, floating]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let disposed = false, timer: ReturnType<typeof setTimeout>, needsConfiguration = true;
    const connect = async () => {
      try {
        if (needsConfiguration || !(await eventBackend.status()).configured) {
          const config = await prepareRef.current();
          const components = floating ? await window.cardbushDesktop?.assistantHomeComponentCatalog?.() : JSON.parse(componentCatalog);
          if (!disposed) { await eventBackend.configure(config, profileRef.current, language, controller.signal, components); needsConfiguration = false; }
        }
      } catch { needsConfiguration = true; }
      finally { if (!disposed) timer = setTimeout(() => void connect(), 30_000); }
    };
    void connect();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [profile, language, configuration, enabled, componentCatalog, floating, catalogRevision]);
  return null;
}

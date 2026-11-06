import { useEffect, useRef } from 'react';
import type { ChatStreamRequest } from '../../backend/api';
import { friendsBackend } from './friendsBackend';
import { useFriendsState } from './friendsStore';

/** Mounted with the App, so closing the Friends surface never owns its scheduler. */
export function FriendsRuntimeConnection({ prepare, language, configuration, enabled }: {
  prepare(): Promise<ChatStreamRequest>; language: string; configuration: unknown; enabled: boolean;
}) {
  const profile = useFriendsState(), prepareRef = useRef(prepare), profileRef = useRef(profile);
  prepareRef.current = prepare; profileRef.current = profile;
  useEffect(() => {
    if (!enabled || !profile.introduction.confirmedAt) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>, needsConfiguration = true;
    const connect = async () => {
      try {
        if (needsConfiguration || !(await friendsBackend.status()).configured) {
          const config = await prepareRef.current();
          if (!disposed) { await friendsBackend.configure(config, profileRef.current, language); needsConfiguration = false; }
        }
      } catch { needsConfiguration = true; }
      finally { if (!disposed) timer = setTimeout(() => void connect(), 30_000); }
    };
    void connect();
    return () => { disposed = true; clearTimeout(timer); };
  }, [profile.introduction.confirmedAt, profile.name, language, configuration, enabled]);
  return null;
}

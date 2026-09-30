import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppLanguage } from '../../types';
import type { BrowserTranslationState } from '../../../electron/browserTranslationTypes';

export function useBrowserTranslation(language: AppLanguage, getGuestId: () => number | undefined) {
  const [state, setState] = useState<BrowserTranslationState>({ status: 'original' });
  const stateRef = useRef(state), generation = useRef(0), guestRef = useRef<number | undefined>(undefined);
  const getGuest = useRef(getGuestId); getGuest.current = getGuestId;
  const languageRef = useRef(language); languageRef.current = language;
  const update = useCallback((next: BrowserTranslationState) => { stateRef.current = next; setState(next); }, []);
  const restore = useCallback((guestWebContentsId: number) => window.cardbushDesktop?.translateInspectorPage?.({
    guestWebContentsId, action: 'restore', language: languageRef.current,
  }).catch(() => undefined), []);
  const reset = useCallback(() => {
    generation.current++;
    if (guestRef.current !== undefined) void restore(guestRef.current);
    guestRef.current = undefined;
    update({ status: 'original' });
  }, [restore, update]);
  useEffect(() => { reset(); }, [language, reset]);
  useEffect(() => () => {
    generation.current++;
    if (guestRef.current !== undefined) void restore(guestRef.current);
  }, [restore]);

  const toggle = useCallback(() => {
    if (stateRef.current.status === 'translating' || stateRef.current.status === 'translated') { reset(); return; }
    const guestWebContentsId = getGuest.current(), translate = window.cardbushDesktop?.translateInspectorPage;
    if (guestWebContentsId === undefined || !translate) { update({ status: 'error', error: 'unavailable' }); return; }
    const current = ++generation.current;
    guestRef.current = guestWebContentsId;
    update({ status: 'translating', language: languageRef.current });
    void translate({ guestWebContentsId, language: languageRef.current, action: 'translate' }).then(result => {
      if (current === generation.current) update(result);
    }).catch(() => {
      if (current === generation.current) update({ status: 'error', error: 'failed' });
    });
  }, [reset, update]);
  return { state, stateRef, toggle, reset };
}

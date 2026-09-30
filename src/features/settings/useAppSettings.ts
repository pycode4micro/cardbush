import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettingsState } from '../../types';
import { readInitialAppSettings } from './appSettingsStore';
import { normalizeIndividuation, readIndividuation, subscribeIndividuation } from './individuation';

function withStoredIndividuation(settings: AppSettingsState): AppSettingsState {
  const stored = readIndividuation();
  const current = normalizeIndividuation(settings.individuation);
  return current.habits === stored.habits && current.predictions === stored.predictions && current.summaryTokenThreshold === stored.summaryTokenThreshold
    ? settings : { ...settings, individuation: stored };
}

export function useAppSettings() {
  const [settings, setSettings] = useState(readInitialAppSettings);
  const latest = useRef(settings);
  const update = useCallback((updater: (current: AppSettingsState) => AppSettingsState) => {
    // Callers persist settings and notify other inputs. Run them outside React's
    // render-time updater, using the latest pending state for consecutive saves.
    const current = latest.current;
    const next = updater(withStoredIndividuation(current));
    if (next !== current) {
      latest.current = next;
      setSettings(next);
    }
  }, []);
  useEffect(() => {
    const sync = () => update(current => current);
    const unsubscribe = subscribeIndividuation(sync);
    sync();
    return unsubscribe;
  }, [update]);
  return [settings, update] as const;
}

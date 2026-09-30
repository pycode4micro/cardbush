import { useMemo, useSyncExternalStore } from 'react';
import { normalizeIndividuation, readIndividuation, saveIndividuation, subscribeIndividuation } from './individuation';

const snapshot = () => JSON.stringify(readIndividuation());
const serverSnapshot = () => JSON.stringify(normalizeIndividuation(undefined));

export function useIndividuation() {
  const saved = useSyncExternalStore(subscribeIndividuation, snapshot, serverSnapshot);
  const settings = useMemo(() => normalizeIndividuation(JSON.parse(saved)), [saved]);
  return {
    ...settings,
    setHabits: (habits: boolean) => saveIndividuation({ ...readIndividuation(), habits }),
  };
}

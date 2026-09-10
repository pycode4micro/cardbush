import { useCallback, useEffect, useRef, useState } from 'react';
import { accountsSnapshotSchema, type AccountCommand, type AccountsSnapshot } from '@cardbush/bush-protocol';

export function useAccounts(language: 'zh' | 'en') {
  const [snapshot, setSnapshot] = useState<AccountsSnapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<Record<string, string>>({});
  const reads = useRef(0), alive = useRef(true), operations = useRef(new Map<string, number>()), active = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    const generation = ++reads.current;
    if (!window.cardbushDesktop?.accountsSnapshot) throw new Error(language === 'zh' ? '请重启 CardBush 以加载账号管理。' : 'Restart CardBush to load account management.');
    const next = accountsSnapshotSchema.parse(await window.cardbushDesktop.accountsSnapshot());
    if (alive.current && generation === reads.current) setSnapshot(next);
  }, [language]);
  useEffect(() => {
    alive.current = true;
    const update = () => { const revision = reads.current + 1; void refresh().catch(() => { if (alive.current && reads.current === revision) setError(language === 'zh' ? '无法读取账号状态，请刷新或重启 CardBush。' : 'Could not read accounts. Refresh or restart CardBush.'); }); };
    const unsubscribe = window.cardbushDesktop?.onAccountsChanged?.(update);
    window.addEventListener('focus', update); update();
    return () => { alive.current = false; reads.current++; unsubscribe?.(); window.removeEventListener('focus', update); };
  }, [language, refresh]);
  const execute = async (command: AccountCommand) => {
    const key = `${command.providerId}:${command.accountId}`;
    if (active.current.has(key) && command.action !== 'cancel_login') return;
    const generation = (operations.current.get(key) ?? 0) + 1;
    operations.current.set(key, generation); active.current.add(key); reads.current++;
    setBusy(value => ({ ...value, [key]: command.action })); setError('');
    const current = () => alive.current && operations.current.get(key) === generation;
    try {
      await window.cardbushDesktop!.accountsAction(command);
      // Read current state: another account may have changed during this action.
      if (current()) await refresh();
    } catch (caught) {
      if (current()) { setError(caught instanceof Error ? caught.message : String(caught)); await refresh().catch(() => {}); }
    } finally {
      if (current()) { active.current.delete(key); setBusy(value => { const next = { ...value }; delete next[key]; return next; }); }
    }
  };
  return { snapshot, error, busy, execute, refresh: async () => { setError(''); try { await refresh(); } catch { setError(language === 'zh' ? '无法读取账号状态，请重试。' : 'Could not read accounts. Try again.'); } } };
}

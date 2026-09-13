import { useEffect, useState } from 'react';
import type { AutomationReminder } from '@cardbush/bush-protocol';

export function useAutomationUnreadCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let disposed = false, revision = 0, timer = 0;
    const refresh = async () => {
      if (!window.cardbushDesktop?.automationCommand) return;
      const current = ++revision;
      try {
        const result = await window.cardbushDesktop.automationCommand({ action: 'reminder' }) as AutomationReminder;
        if (!disposed && revision === current && Number.isInteger(result.total)) setCount(result.total);
      } catch { /* Keep the last known count while the runtime reconnects. */ }
    };
    const update = () => { clearTimeout(timer); timer = window.setTimeout(() => void refresh(), 150); };
    const unsubscribe = window.cardbushDesktop?.onAutomationChanged?.(update);
    window.addEventListener('focus', update); void refresh();
    return () => { disposed = true; revision++; clearTimeout(timer); unsubscribe?.(); window.removeEventListener('focus', update); };
  }, []);
  return count;
}

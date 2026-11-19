import { useEffect, useState } from 'react';
import type { StorageInventory } from '@cardbush/bush-protocol';
import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';

export function StorageInventoryPanel({ load, revision, language }: {
  load: () => Promise<StorageInventory>;
  revision: number;
  language: AppLanguage;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<StorageInventory | 'loading' | 'unavailable'>('loading');
  const text = uiText(language);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setState('loading');
    void load().then(value => { if (active) setState(value); }, () => { if (active) setState('unavailable'); });
    return () => { active = false; };
  }, [open, load, revision]);

  const numbers = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const size = (bytes: number) => {
    const [unit, divisor] = bytes >= 1_000_000 ? ['megabyte', 1_000_000] as const :
      bytes >= 1_000 ? ['kilobyte', 1_000] as const : ['byte', 1] as const;
    return new Intl.NumberFormat(language, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 })
      .format(bytes / divisor);
  };
  return <details className="settings-disclosure" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{text('storage.title')}</summary>
    <div className="settings-disclosure-body">
      {typeof state === 'string'
        ? <p role="status">{text(state === 'loading' ? 'common.loading' : 'storage.unavailable')}</p>
        : <ul className="storage-inventory-list">
          {state.rows.map(row => <li key={row.category}>
            <span><strong>{text(`storage.category.${row.category}`)}</strong><small>{text(`storage.policy.${row.policy}`)}</small></span>
            <span>{row.usage ? text('storage.usage', {
              files: numbers.format(row.usage.files), size: size(row.usage.bytes),
            }) : text('storage.unavailable')}</span>
          </li>)}
        </ul>}
    </div>
  </details>;
}

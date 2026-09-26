import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, Upload, Trash2 } from 'lucide-react';
import type { CalendarCommand, CalendarState } from '@cardbush/bush-protocol';

export function useCalendarData() {
  const [state, setState] = useState<CalendarState>({ datasets: [], chineseLunar: false });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const alive = useRef(true), revision = useRef(0), mutating = useRef(false);
  const refresh = useCallback(async () => {
    if (!window.cardbushDesktop?.calendarCommand) return;
    const ticket = ++revision.current;
    try { const result = await window.cardbushDesktop.calendarCommand({ action: 'list' }); if (alive.current && ticket === revision.current) { setState(result.state); setError(''); } }
    catch (error) { if (alive.current && ticket === revision.current) setError(String(error)); }
  }, []);
  useEffect(() => {
    alive.current = true; void refresh();
    const unsubscribe = window.cardbushDesktop?.onCalendarChanged?.(() => void refresh());
    return () => { alive.current = false; revision.current++; unsubscribe?.(); };
  }, [refresh]);
  const command = async (command: CalendarCommand) => {
    if (mutating.current) return;
    if (!window.cardbushDesktop?.calendarCommand) { setError('请重启 CardBush 以加载日历导入服务。'); return; }
    mutating.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.cardbushDesktop.calendarCommand(command);
      if (alive.current) { revision.current++; setState(result.state); if (result.imported) setNotice(result.imported); }
    } catch (error) { if (alive.current) setError(String(error).replace(/^Error: /, '')); }
    finally { mutating.current = false; if (alive.current) setBusy(false); }
  };
  return { state, busy, error, notice, command };
}
export function CalendarDataControls({ data, zh }: { data: ReturnType<typeof useCalendarData>; zh: boolean }) {
  return <><details className="calendar-data-controls">
    <summary><CalendarDays size={14}/>{zh ? '日历数据' : 'Calendars'}{data.state.datasets.length > 0 && <span>{data.state.datasets.length}</span>}</summary>
    <div className="calendar-data-body">
      <div className="calendar-data-actions">
        <button type="button" disabled={data.busy} onClick={() => void data.command({ action: 'import' })}><Upload size={14}/>{data.busy ? (zh ? '处理中…' : 'Working…') : (zh ? '导入 JSON / ICS' : 'Import JSON / ICS')}</button></div>
      <p>{zh ? '内置日历默认关闭，勾选即可显示。也可导入节假日、调休和纪念日；这些资料仅用于展示。' : 'Built-in calendars are off by default. Enable one to show its dates, or import holidays and anniversaries. Calendar data is for display only.'}</p>
      {data.state.datasets.map(({ calendar, enabled, builtin }) => <div className="calendar-data-row" key={calendar.id} data-calendar-id={calendar.id} data-builtin={Boolean(builtin)}>
        <label><input type="checkbox" checked={enabled} disabled={data.busy} onChange={event => void data.command({ action: 'enabled', id: calendar.id, enabled: event.target.checked })}/><span>{calendar.name}<small>{builtin
          ? `${calendar.recurrenceWindow?.from.slice(0, 4)}–${Number(calendar.recurrenceWindow?.to.slice(0, 4)) - 1} · ${calendar.id === 'cardbush.chinese' ? (zh ? '农历与常见节日，不含调休' : 'Lunar dates and common festivals; no adjusted workdays') : (zh ? '联邦节日及周末补休' : 'Federal holidays and observed dates')}`
          : `${calendar.entries.length} ${zh ? '条' : 'entries'}${calendar.recurrenceWindow ? ` · ${calendar.recurrenceWindow.from} – ${calendar.recurrenceWindow.to} ${zh ? '重复展开范围（结束日不含）' : 'recurrence window (exclusive end)'}` : ''}`}</small></span></label>
        {builtin ? <span className="calendar-data-builtin">{zh ? '内置' : 'Built-in'}</span> : <button type="button" disabled={data.busy} aria-label={`${zh ? '移除日历' : 'Remove calendar'} ${calendar.name}`} onClick={() => void data.command({ action: 'remove', id: calendar.id })}><Trash2 size={14}/></button>}
      </div>)}
      {data.notice && <p role="status">{zh ? '已导入：' : 'Imported: '}{data.notice}</p>}
    </div>
  </details>{data.error && <p className="automation-error" role="alert">{data.error}</p>}</>;
}

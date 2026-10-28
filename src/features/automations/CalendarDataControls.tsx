import { uiText } from '../../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, Upload, Trash2 } from 'lucide-react';
import type { CalendarCommand, CalendarState } from '@cardbush/bush-protocol';
import './calendarData.css';

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
    if (!window.cardbushDesktop?.calendarCommand) { setError(uiText()('calendarDataControls.restart_cardbush_to_load_the_calendar_import')); return; }
    mutating.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.cardbushDesktop.calendarCommand(command);
      if (alive.current) { revision.current++; setState(result.state); if (result.imported) setNotice(result.imported); }
    } catch (error) { if (alive.current) setError(String(error).replace(/^Error: /, '')); }
    finally { mutating.current = false; if (alive.current) setBusy(false); }
  };
  return { state, busy, error, notice, command };
}
export function CalendarDataControls({ data, uiLanguage, expanded = false }: { data: ReturnType<typeof useCalendarData>; uiLanguage: string; expanded?: boolean }) {
  return <><details className="calendar-data-controls" open={expanded || undefined}>
    <summary><CalendarDays size={14}/>{uiText(uiLanguage)('calendarDataControls.calendars')}{data.state.datasets.length > 0 && <span>{data.state.datasets.length}</span>}</summary>
    <div className="calendar-data-body">
      <div className="calendar-data-actions">
        <button type="button" disabled={data.busy} onClick={() => void data.command({ action: 'import' })}><Upload size={14}/>{data.busy ? (uiText(uiLanguage)('calendarDataControls.working')) : (uiText(uiLanguage)('calendarDataControls.importJsonIcs'))}</button></div>
      <p>{uiText(uiLanguage)('calendarDataControls.builtInCalendarsAreOffByDefault')}</p>
      {data.state.datasets.map(({ calendar, enabled, builtin }) => <div className="calendar-data-row" key={calendar.id} data-calendar-id={calendar.id} data-builtin={Boolean(builtin)}>
        <label><input type="checkbox" checked={enabled} disabled={data.busy} onChange={event => void data.command({ action: 'enabled', id: calendar.id, enabled: event.target.checked })}/><span>{calendar.name}<small>{builtin
          ? `${calendar.recurrenceWindow?.from.slice(0, 4)}–${Number(calendar.recurrenceWindow?.to.slice(0, 4)) - 1} · ${calendar.id === 'cardbush.chinese' ? (uiText(uiLanguage)('calendarDataControls.lunarDatesAndCommonFestivalsNoAdjusted')) : (uiText(uiLanguage)('calendarDataControls.federalHolidaysAndObservedDates'))}`
          : `${calendar.entries.length} ${uiText(uiLanguage)('calendarDataControls.entries')}${calendar.recurrenceWindow ? ` · ${calendar.recurrenceWindow.from} – ${calendar.recurrenceWindow.to} ${uiText(uiLanguage)('calendarDataControls.recurrenceWindowExclusiveEnd')}` : ''}`}</small></span></label>
        {builtin ? <span className="calendar-data-builtin">{uiText(uiLanguage)('componentsApp.builtIn')}</span> : <button type="button" disabled={data.busy} aria-label={`${uiText(uiLanguage)('calendarDataControls.removeCalendar')} ${calendar.name}`} onClick={() => void data.command({ action: 'remove', id: calendar.id })}><Trash2 size={14}/></button>}
      </div>)}
      {data.notice && <p role="status">{uiText(uiLanguage)('calendarDataControls.imported')}{data.notice}</p>}
    </div>
  </details>{data.error && <p className="calendar-data-error" role="alert">{data.error}</p>}</>;
}

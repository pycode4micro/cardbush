import { uiText } from '../../i18n';
import type { ReactNode } from 'react';
import { calendarDayKey } from './automationCalendarModel';
import './calendarSurface.css';

/** The widget and the schedule page share the same uncluttered month grid. */
export function CalendarMonthGrid({ days, month, language, renderDay, className = '' }: {
  days: Date[]; month: number; language: string; renderDay: (day: Date) => ReactNode; className?: string;
}) {
  const visible = days.slice(0, Math.ceil((days.findIndex(day => day.getMonth() === month) + days.filter(day => day.getMonth() === month).length) / 7) * 7);
  return <div className={`calendar-month-grid ${className}`} role="table" aria-label={uiText(language)('calendarMonthGrid.monthCalendar')}>
    <div role="row" className="calendar-weekdays">{([uiText(language)('calendarMonthGrid.m'), uiText(language)('calendarMonthGrid.t'), uiText(language)('calendarMonthGrid.w'), uiText(language)('calendarMonthGrid.t_0e2460b'), uiText(language)('calendarMonthGrid.f'), uiText(language)('calendarMonthGrid.s'), uiText(language)('calendarMonthGrid.s_c1d9164')]).map((day, index) => <span role="columnheader" key={index}>{day}</span>)}</div>
    {Array.from({ length: visible.length / 7 }, (_, week) => <div role="row" key={week}>
      {visible.slice(week * 7, week * 7 + 7).map(day => <div role="cell" key={calendarDayKey(day)}>{day.getMonth() === month ? renderDay(day) : null}</div>)}
    </div>)}
  </div>;
}

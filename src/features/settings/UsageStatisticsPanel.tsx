import { uiText } from '../../i18n';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { SettingsCard } from './SettingsControls';
import { loadCumulativeUsageStatistics, type CumulativeUsageStatistics } from './usageActivity';

export function UsageStatisticsPanel({ language, active = true }: { language: AppLanguage; active?: boolean }) {

  const [statistics, setStatistics] = useState<CumulativeUsageStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [activityRange, setActivityRange] = useState<UsageHeatmapRange>('year');

  useEffect(() => {
    if (!active) return;
    let alive = true, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await loadCumulativeUsageStatistics();
        if (alive) { setStatistics(result); setError(false); }
      } catch { if (alive) setError(true); }
      finally { pending = false; if (alive) setLoading(false); }
    };
    void refresh();
    const onFocus = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(onFocus, 15_000);
    window.addEventListener('focus', onFocus);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [active, retry]);

  const heatmap = useMemo(() => usageHeatmap(statistics?.activity ?? [], language, activityRange), [statistics?.activity, language, activityRange]);
  const locale = language;
  const statItems = [
    { label: uiText(language)('usageStatisticsPanel.totalTokens'), value: statistics?.totalTokens },
    { label: uiText(language)('usageStatisticsPanel.inputTokens'), value: statistics?.promptTokens },
    { label: uiText(language)('usageStatisticsPanel.outputTokens'), value: statistics?.completionTokens },
    { label: uiText(language)('usageStatisticsPanel.activeDays'), value: statistics?.activeDays },
  ];
  const startedDay = statistics ? localDayKey(new Date(statistics.startedAt)) : '';
  const describeDay = (day: typeof heatmap.days[number]) => {
    const date = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(new Date(`${day.date}T12:00:00`));
    if (day.date < startedDay) return uiText(language)('usageStatisticsPanel.beforeRecordingBegan', { date });
    return uiText(language)('usageStatisticsPanel.tokensUsed', { date, value2: day.tokens.toLocaleString(locale) });
  };

  return <div className="usage-settings">
    <SettingsCard title={uiText(language)('usageStatisticsPanel.usageOverview')}>
    <div className="usage-stat-grid" aria-busy={loading}>
      {statItems.map(item => <div className="usage-stat" key={item.label} title={item.value?.toLocaleString(locale)}>
        <strong>{item.value === undefined ? '—' : formatUsageNumber(item.value, locale)}</strong><span>{item.label}</span>
      </div>)}
    </div>
    </SettingsCard>
    <SettingsCard className="usage-activity-card" title={uiText(language)('usageStatisticsPanel.tokenActivity')} headerAction={
      <div className="usage-activity-actions">
        <div className="usage-range-switcher" role="group" aria-label={uiText(language)('usageStatisticsPanel.activityDateRange')}>
          {(['year', 'month', 'week'] as const).map(range => <button type="button" className={activityRange === range ? 'active' : ''}
            aria-pressed={activityRange === range} key={range} onClick={() => setActivityRange(range)}>
            {(({ year: uiText(language)('usageStatisticsPanel.year'), month: uiText(language)('usageStatisticsPanel.month'), week: uiText(language)('usageStatisticsPanel.week') }))[range]}
          </button>)}
        </div>
        {loading && <LoaderCircle className="spin" size={15} aria-hidden="true" />}
      </div>
    }>
    <div className="usage-heatmap-scroll">
      <div className={`usage-heatmap-frame range-${activityRange}`} style={{ '--usage-heatmap-columns': heatmap.weekCount } as CSSProperties}>
        <div className="usage-heatmap-grid" key={`${activityRange}-${Boolean(statistics)}-${active}`} aria-label={uiText(language)('usageStatisticsPanel.tokenUsageActivity')}>
          {heatmap.days.map((day, index) => <button type="button" key={day.date}
            className={`usage-heatmap-cell level-${day.level}${day.future ? ' future' : ''}${statistics && active ? ' entering' : ''}`}
            style={{ '--usage-enter-delay': `${Math.floor(index / 7) * 11}ms` } as CSSProperties}
            aria-label={statistics ? describeDay(day) : day.date} aria-disabled={day.future || !statistics}
            tabIndex={index === Math.min(heatmap.todayIndex, heatmap.days.length - 1) ? 0 : -1}
            onKeyDown={event => {
              const offset = ({ ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[event.key];
              if (offset === undefined) return;
              event.preventDefault();
              const target = event.currentTarget.parentElement?.children[Math.max(0, Math.min(index + offset, heatmap.todayIndex))] as HTMLElement;
              target?.focus();
            }} />)}
        </div>
        <div className="usage-month-labels" aria-hidden="true">
          {heatmap.monthLabels.map((label, index) => label && <span key={index}
            style={{ gridColumn: `${Math.max(1, index >= heatmap.weekCount - 2 ? heatmap.weekCount - 2 : index + 1)} / -1` }}
            className={index >= heatmap.weekCount - 2 ? 'align-end' : undefined}>{label}</span>)}
        </div>
      </div>
    </div>
    {statistics && <div className="usage-insights">
      <span>{uiText(language)('usageStatisticsPanel.modelRequests', { value1: statistics.requestCount.toLocaleString(locale) })}</span>
      <span>{uiText(language)('usageStatisticsPanel.dayLongestStreak', { value1: statistics.longestStreak })}</span>
    </div>}
    </SettingsCard>
    {error && <p className="usage-load-error" role="alert">{uiText(language)('usageStatisticsPanel.unableToReadUsageRecords')}
      <button className="secondary-button" type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={13} />{uiText(language)('common.retry')}</button>
    </p>}
    {statistics && <p className="usage-recording-note">{uiText(language)('usageStatisticsPanel.recordingProviderReportedTokensSinceClearingCaches', { value1: new Date(statistics.startedAt).toLocaleDateString(locale) })}</p>}
  </div>;
}

function formatUsageNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

type UsageHeatmapRange = 'year' | 'month' | 'week';

function usageHeatmap(activity: CumulativeUsageStatistics['activity'], language: AppLanguage, range: UsageHeatmapRange) {
  const byDate = new Map(activity.map(day => [day.date, day.tokens]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today), end = new Date(today);
  if (range === 'year') {
    start.setDate(start.getDate() - start.getDay() - 52 * 7);
    end.setTime(start.getTime()); end.setDate(start.getDate() + 53 * 7 - 1);
  } else if (range === 'month') {
    start.setDate(1); start.setDate(start.getDate() - start.getDay());
    end.setMonth(end.getMonth() + 1, 0); end.setDate(end.getDate() + 6 - end.getDay());
  } else {
    start.setDate(start.getDate() - start.getDay());
    end.setTime(start.getTime()); end.setDate(start.getDate() + 6);
  }
  // Use calendar dates instead of elapsed hours so DST cannot add/drop columns.
  const dateDistance = (left: Date, right: Date) => (Date.parse(localDayKey(left)) - Date.parse(localDayKey(right))) / 86_400_000;
  const weekCount = Math.round((dateDistance(end, start) + 1) / 7);
  const maximum = Math.max(1, ...activity.filter(day => day.date >= localDayKey(start) && day.date <= localDayKey(end)).map(day => day.tokens));
  const days = Array.from({ length: weekCount * 7 }, (_, index) => {
    const date = new Date(start); date.setDate(start.getDate() + index);
    const key = localDayKey(date), tokens = byDate.get(key) ?? 0;
    return { date: key, tokens, future: date > today, level: tokens ? Math.max(1, Math.ceil(tokens / maximum * 4)) : 0 };
  });
  const formatter = new Intl.DateTimeFormat(language, { month: 'short' });
  const monthLabels = Array.from({ length: weekCount }, (_, index) => {
    const current = new Date(start); current.setDate(start.getDate() + index * 7);
    const previous = new Date(current); previous.setDate(current.getDate() - 7);
    if (range === 'month') return index === 0 ? formatter.format(today) : '';
    return index === 0 || current.getMonth() !== previous.getMonth() ? formatter.format(current) : '';
  });
  return { days, monthLabels, weekCount, todayIndex: dateDistance(today, start) };
}

function localDayKey(date: Date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

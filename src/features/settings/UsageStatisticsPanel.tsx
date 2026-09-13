import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { loadCumulativeUsageStatistics, type CumulativeUsageStatistics } from './usageActivity';

export function UsageStatisticsPanel({ language, active = true }: { language: AppLanguage; active?: boolean }) {
  const zh = language === 'zh';
  const [statistics, setStatistics] = useState<CumulativeUsageStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [activityRange, setActivityRange] = useState<UsageHeatmapRange>('year');
  const [hovered, setHovered] = useState<{ text: string; x: number; y: number } | null>(null);
  const tooltip = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    const node = tooltip.current;
    if (!hovered || !node) { node?.hidePopover(); return; }
    node.showPopover();
    const halfWidth = node.getBoundingClientRect().width / 2;
    node.style.left = `${Math.min(Math.max(hovered.x, halfWidth + 12), window.innerWidth - halfWidth - 12)}px`;
    const dismiss = () => setHovered(null);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => { document.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss); };
  }, [hovered]);
  useEffect(() => { setHovered(null); }, [activityRange, active]);

  const heatmap = useMemo(() => usageHeatmap(statistics?.activity ?? [], language, activityRange), [statistics?.activity, language, activityRange]);
  const locale = zh ? 'zh-CN' : 'en-US';
  const statItems = [
    { label: zh ? '累计 Token' : 'Total tokens', value: statistics?.totalTokens },
    { label: zh ? '输入 Token' : 'Input tokens', value: statistics?.promptTokens },
    { label: zh ? '输出 Token' : 'Output tokens', value: statistics?.completionTokens },
    { label: zh ? '活跃天数' : 'Active days', value: statistics?.activeDays },
  ];
  const startedDay = statistics ? localDayKey(new Date(statistics.startedAt)) : '';
  const describeDay = (day: typeof heatmap.days[number]) => {
    const date = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(new Date(`${day.date}T12:00:00`));
    if (day.date < startedDay) return zh ? `${date} · 尚未开始记录` : `${date} · Before recording began`;
    return zh ? `${date} 使用了 ${day.tokens.toLocaleString(locale)} 个 Token` : `${date}: ${day.tokens.toLocaleString(locale)} tokens used`;
  };
  const showDay = (day: typeof heatmap.days[number], element: HTMLElement) => {
    if (!statistics || day.future) { setHovered(null); return; }
    const rect = element.getBoundingClientRect();
    setHovered({ text: describeDay(day), x: Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140), y: rect.top - 10 });
  };

  return <div className="usage-settings">
    <div className="usage-stat-grid" aria-busy={loading}>
      {statItems.map(item => <div className="usage-stat" key={item.label} title={item.value?.toLocaleString(locale)}>
        <strong>{item.value === undefined ? '—' : formatUsageNumber(item.value, locale)}</strong><span>{item.label}</span>
      </div>)}
    </div>
    <div className="usage-activity-header">
      <strong>{zh ? 'Token 活动' : 'Token activity'}</strong>
      <div className="usage-activity-actions">
        <div className="usage-range-switcher" role="group" aria-label={zh ? '活跃度日期跨度' : 'Activity date range'}>
          {(['year', 'month', 'week'] as const).map(range => <button type="button" className={activityRange === range ? 'active' : ''}
            aria-pressed={activityRange === range} key={range} onClick={() => setActivityRange(range)}>
            {zh ? { year: '年', month: '月', week: '周' }[range] : { year: 'Year', month: 'Month', week: 'Week' }[range]}
          </button>)}
        </div>
        {loading && <LoaderCircle className="spin" size={15} aria-hidden="true" />}
      </div>
    </div>
    <div className="usage-heatmap-scroll" onPointerLeave={() => setHovered(null)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHovered(null); }}>
      <div className={`usage-heatmap-frame range-${activityRange}`} style={{ '--usage-heatmap-columns': heatmap.weekCount } as CSSProperties}>
        <div className="usage-heatmap-grid" key={`${activityRange}-${Boolean(statistics)}-${active}`} aria-label={zh ? 'Token 使用活动' : 'Token usage activity'}>
          {heatmap.days.map((day, index) => <button type="button" key={day.date}
            className={`usage-heatmap-cell level-${day.level}${day.future ? ' future' : ''}${statistics && active ? ' entering' : ''}`}
            style={{ '--usage-enter-delay': `${Math.floor(index / 7) * 11}ms` } as CSSProperties}
            aria-label={statistics ? describeDay(day) : day.date} aria-disabled={day.future || !statistics}
            tabIndex={index === Math.min(heatmap.todayIndex, heatmap.days.length - 1) ? 0 : -1}
            onPointerEnter={event => showDay(day, event.currentTarget)} onFocus={event => showDay(day, event.currentTarget)}
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
    <div ref={tooltip} popover="manual" className="usage-tooltip" role="tooltip"
      style={hovered ? { left: hovered.x, top: hovered.y } : undefined}>{hovered?.text}</div>
    {statistics && <div className="usage-insights">
      <span>{zh ? `${statistics.requestCount.toLocaleString(locale)} 次模型请求` : `${statistics.requestCount.toLocaleString(locale)} model requests`}</span>
      <span>{zh ? `最长连续 ${statistics.longestStreak} 天` : `${statistics.longestStreak}-day longest streak`}</span>
    </div>}
    {error && <p className="usage-load-error" role="alert">{zh ? '无法读取用量记录。' : 'Unable to read usage records.'}
      <button className="secondary-button" type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={13} />{zh ? '重试' : 'Retry'}</button>
    </p>}
    {statistics && <p className="usage-recording-note">{zh
      ? `自 ${new Date(statistics.startedAt).toLocaleDateString(locale)} 起记录模型服务返回的 Token 用量；清理缓存或删除会话不会清除统计。`
      : `Recording provider-reported tokens since ${new Date(statistics.startedAt).toLocaleDateString(locale)}. Clearing caches or conversations does not remove these statistics.`}</p>}
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
  const formatter = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', { month: 'short' });
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

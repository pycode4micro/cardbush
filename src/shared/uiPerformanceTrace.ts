type UiPerformanceMetric = {
  count: number;
  total: number;
  max: number;
};

type UiPerformanceWindow = {
  sessionId: string;
  startedAt: number;
  metrics: Map<string, UiPerformanceMetric>;
};

const performanceWindowMs = 2_000;
const recentWindowLimit = 60;
const windows = new Map<string, UiPerformanceWindow>();
let flushTimer: number | undefined;
let activeSessionId = '';

export function setUiPerformanceActiveSession(sessionId: string) {
  activeSessionId = sessionId.trim();
}

export function recordUiPerformanceMetric(
  name: string,
  options: {
    sessionId?: string;
    value?: number;
  } = {},
) {
  if (typeof window === 'undefined' || !uiPerformanceTraceEnabled()) return;
  const sessionId = options.sessionId?.trim() || activeSessionId || 'unbound';
  const bucket = performanceWindow(sessionId);
  const value = Number.isFinite(options.value) ? Number(options.value) : 1;
  const current = bucket.metrics.get(name) ?? { count: 0, total: 0, max: 0 };
  current.count += 1;
  current.total += value;
  current.max = Math.max(current.max, value);
  bucket.metrics.set(name, current);
  schedulePerformanceFlush();
}

export function installUiLongTaskObserver() {
  if (
    typeof window === 'undefined' ||
    typeof PerformanceObserver === 'undefined' ||
    !uiPerformanceTraceEnabled()
  ) {
    return () => undefined;
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordUiPerformanceMetric('main_thread_long_task_ms', {
          value: entry.duration,
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: false });
    return () => observer.disconnect();
  } catch {
    return () => undefined;
  }
}

function uiPerformanceTraceEnabled() {
  try {
    return window.sessionStorage.getItem('cardbush_ui_performance_debug') === 'true';
  } catch {
    return false;
  }
}

function performanceWindow(sessionId: string) {
  const existing = windows.get(sessionId);
  if (existing) return existing;
  const created: UiPerformanceWindow = {
    sessionId,
    startedAt: performance.now(),
    metrics: new Map(),
  };
  windows.set(sessionId, created);
  return created;
}

function schedulePerformanceFlush() {
  if (flushTimer !== undefined) return;
  flushTimer = window.setTimeout(flushPerformanceWindows, performanceWindowMs);
}

function flushPerformanceWindows() {
  flushTimer = undefined;
  const completedAt = performance.now();
  for (const bucket of windows.values()) {
    const metrics = Object.fromEntries(
      [...bucket.metrics.entries()].map(([name, value]) => [name, {
        count: value.count,
        total: round(value.total),
        max: round(value.max),
      }]),
    );
    const shouldPersist =
      (metrics.reasoning_delta_received?.count ?? 0) >= 10 ||
      (metrics.main_thread_long_task_ms?.count ?? 0) > 0 ||
      (metrics.chat_panel_commit_ms?.max ?? 0) >= 16 ||
      (metrics.sidebar_commit_ms?.max ?? 0) >= 16;
    if (!shouldPersist) continue;
    const entry = {
      type: 'ui_performance_window',
      sessionId: bucket.sessionId,
      durationMs: round(completedAt - bucket.startedAt),
      metrics,
    };
    const recent = window.__cardbushUiPerformance ?? [];
    recent.push(entry);
    if (recent.length > recentWindowLimit) {
      recent.splice(0, recent.length - recentWindowLimit);
    }
    window.__cardbushUiPerformance = recent;
    console.info('[cardbush:ui-performance]', entry);
    void window.cardbushDesktop
      ?.writeDebugLog?.('ui-performance', entry)
      .catch(() => undefined);
  }
  windows.clear();
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

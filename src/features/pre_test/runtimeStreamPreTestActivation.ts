export type RuntimeStreamPreTestMode = 'fixture' | 'live';

export function runtimeStreamPreTestMode(): RuntimeStreamPreTestMode | null {
  const query = new URLSearchParams(window.location.search).get('pre_test');
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('pre_test');
  const stored = window.localStorage.getItem('cardbush_pre_test');
  const value = query || hash || stored;
  if (value === 'runtime-live') return 'live';
  if (value === 'runtime-stream') return 'fixture';
  return null;
}

export function isRuntimeStreamPreTestEnabled() {
  return runtimeStreamPreTestMode() !== null;
}

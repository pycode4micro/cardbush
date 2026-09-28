/** Resolve the app override before consulting the OS, including non-DOM tests. */
export function prefersReducedMotion() {
  const preference = typeof document === 'undefined' ? undefined : document.documentElement?.dataset?.motionPreference;
  if (preference === 'on') return true;
  if (preference === 'off') return false;
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

export function isRuntimeStreamPreTestEnabled() {
  const query = new URLSearchParams(window.location.search).get('pre_test');
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('pre_test');
  return (
    query === 'runtime-stream' ||
    hash === 'runtime-stream' ||
    window.localStorage.getItem('cardbush_pre_test') === 'runtime-stream'
  );
}

export function rendererSurface(search = window.location.search) {
  const surface = new URLSearchParams(search).get('window');
  return surface === 'assistant' || surface === 'shadow' ? surface : 'workspace';
}

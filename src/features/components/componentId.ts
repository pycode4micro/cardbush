/** getRandomValues also works in opaque-origin component frames. */
export function componentId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
}

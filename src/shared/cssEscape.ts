export function cssEscape(value: string) {
  return value.replace(/["\\]/g, '\\$&');
}

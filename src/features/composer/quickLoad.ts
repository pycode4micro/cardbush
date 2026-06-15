export type QuickLoadPayload = {
  kind: 'text' | 'file' | 'folder';
  title: string;
  value: string;
};

export function quickPayloadText(payload: QuickLoadPayload) {
  const value = payload.value.trim();
  if (!value) {
    return '';
  }
  if (payload.kind === 'text') {
    return value;
  }
  const suffix = payload.kind === 'folder' && !value.endsWith('/') ? '/' : '';
  return `@${value}${suffix}`;
}

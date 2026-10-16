import { canvasLayoutFacts, readUserPrompt, type CanvasItem, type CanvasSnapshot, type CreationCanvas, type UserPromptInput } from '@cardbush/bush-protocol';

export function canvasFileTarget(source: string, manifest: string) {
  if (/^(?:[a-z][\w+.-]*:|[\\/])/i.test(source)) return source;
  const directory = manifest.replace(/[\\/][^\\/]+$/, '').replaceAll('\\', '/');
  // URL resolution handles ../ and spaces consistently on Windows and POSIX.
  const encodedSource = source.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/');
  const encodedDirectory = directory.split('/').map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)).join('/');
  const url = new URL(encodedSource, `file://${directory.startsWith('/') ? '' : '/'}${encodedDirectory}/`);
  return decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
}
type WithoutFrame<T> = T extends unknown ? Omit<T, 'frame'> : never;
export function editableCanvasMarkdown(item: CanvasItem) {
  return item.kind === 'markdown' || item.kind === 'file' && !item.reference && /\.(md|markdown)$/i.test(item.source) && !/^[a-z][\w+.-]*:\/\//i.test(item.source);
}
export function placeCanvasItems(document: CreationCanvas, items: Array<WithoutFrame<CanvasItem>>, size = { width: 640, height: 420 }) {
  const next = structuredClone(document);
  for (const item of items) {
    const width = Math.min(size.width, next.width - 48), height = size.height;
    let x = 24, y = 24;
    const collision = () => next.items.some(existing => { const f = existing.frame; return x < f.x + f.width + 24 && x + width + 24 > f.x && y < f.y + f.height + 24 && y + height + 24 > f.y; });
    while (collision()) { x += width + 24; if (x + width + 24 > next.width) { x = 24; y += 48; } if (y > 49000) throw Error('Canvas is full.'); }
    next.height = Math.max(next.height, y + height + 24);
    next.items.push({ ...item, frame: { x, y, width, height } } as CanvasItem);
  }
  return next;
}
export function canvasRequest(input: UserPromptInput, snapshot: CanvasSnapshot, selectedId: string | undefined, viewport: { width: number; height: number; zoom: number }): UserPromptInput {
  const prompt = readUserPrompt(input);
  return { ...prompt, context: [...(prompt.context ?? []), { kind: 'editing-location', content:
    `The user is creating a multi-file canvas in CardBush. Manifest: ${JSON.stringify(snapshot.path)}. Use design(action=inspect, path) to read the current content and revision; then design(action=update) to assemble items. Use existing file tools/plugins to create and edit source documents, not simulated typing. Preserve unrelated items and user changes. HTML items use the existing isolated component renderer (self-contained inline HTML/CSS/JS and data images; no local files/network). File items use native previews; paths are absolute or relative to the manifest. A region with reference.mode=snapshot is a captured excerpt, not a live view; its reference identifies the editable source. Write new assets next to the manifest. No project setup is needed.\nCurrent layout facts: ${JSON.stringify({ ...canvasLayoutFacts(snapshot.document), selectedId, viewport })}` }] };
}

import type { TranslationText } from './browserTranslationTypes.js';

type PageCommand = { action: 'collect' | 'apply' | 'restore'; jobId?: string; texts?: TranslationText[] };

/** Serialized into a private guest world. Only text nodes are changed, never page HTML. */
function translationDocument(command: PageCommand) {
  // Local DOM shapes keep browser-only globals out of the Node host's type environment.
  type PageElement = { parentElement: PageElement | null; closest: (selector: string) => PageElement | null };
  type TextNode = { parentElement: PageElement | null; textContent: string | null; data: string; isConnected: boolean };
  const { document, NodeFilter, getComputedStyle } = globalThis as unknown as {
    document: { body: PageElement | null; documentElement: PageElement; createTreeWalker: (root: PageElement, mask: number) => { nextNode: () => TextNode | null } };
    NodeFilter: { SHOW_TEXT: number };
    getComputedStyle: (element: PageElement) => { display: string; visibility: string; opacity: string };
  };
  type Entry = { node: TextNode; original: string; translated?: string };
  type Snapshot = { id: string; entries: Map<string, Entry> };
  const scope = globalThis as typeof globalThis & { __cardbushTranslation?: Snapshot };
  let snapshot = scope.__cardbushTranslation;
  const restore = (jobId?: string) => {
    if (!snapshot || jobId && snapshot.id !== jobId) return;
    for (const entry of snapshot.entries.values()) {
      // Page scripts/user edits that happened afterwards take precedence.
      if (entry.node.isConnected && entry.translated !== undefined && entry.node.data === entry.translated) {
        entry.node.data = entry.original;
      }
    }
    delete scope.__cardbushTranslation;
  };
  if (command.action === 'restore') { restore(command.jobId); return { count: 0 }; }
  if (command.action === 'apply') {
    if (!snapshot || snapshot.id !== command.jobId) return { count: 0 };
    let count = 0;
    for (const item of command.texts ?? []) {
      const entry = snapshot.entries.get(item.id);
      if (!entry?.node.isConnected || entry.node.data !== entry.original) continue;
      const leading = entry.original.match(/^\s*/)?.[0] ?? '';
      const trailing = entry.original.match(/\s*$/)?.[0] ?? '';
      entry.translated = leading + item.text.trim() + trailing;
      entry.node.data = entry.translated;
      count++;
    }
    return { count };
  }
  // Starting a new translation always reads the originals.
  restore();
  snapshot = { id: command.jobId ?? '', entries: new Map() };
  const texts: TranslationText[] = [];
  let characters = 0, partial = false, visited = 0;
  const excluded = 'script,style,noscript,textarea,input,select,option,pre,code,kbd,samp,svg,canvas,math,iframe,object,embed,[hidden],[inert],[aria-hidden="true"],[translate="no"],.notranslate,[contenteditable]:not([contenteditable="false"])';
  const visibility = new WeakMap<PageElement, boolean>();
  const visible = (element: PageElement): boolean => {
    const cached = visibility.get(element);
    if (cached !== undefined) return cached;
    const style = getComputedStyle(element);
    const value = style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && style.opacity !== '0' && (!element.parentElement || visible(element.parentElement));
    visibility.set(element, value);
    return value;
  };
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  let node: TextNode | null;
  while ((node = walker.nextNode())) {
    if (++visited > 50_000) { partial = true; break; }
    const parent = node.parentElement, text = node.textContent?.trim() ?? '';
    if (!parent || !text || !/\p{L}/u.test(text) || parent.closest(excluded) || !visible(parent)) continue;
    if (text.length > 6000) { partial = true; continue; }
    if (texts.length >= 800 || characters + text.length > 80_000) { partial = true; break; }
    const id = String(texts.length);
    texts.push({ id, text });
    snapshot.entries.set(id, { node, original: node.textContent ?? '' });
    characters += text.length;
  }
  scope.__cardbushTranslation = snapshot;
  return { texts, partial };
}

// Do not expose a general-purpose script execution IPC to the renderer.
export function browserTranslationScript(command: PageCommand): string {
  return `(${translationDocument.toString()})(${JSON.stringify(command)})`;
}

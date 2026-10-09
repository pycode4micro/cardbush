import { localApplicationPath } from './localApplications';

/** Explicit, portable Markdown references created by the composer. No ambient context. */
export type BrowserPromptReference = { kind: 'browser'; tabId: string; pageId?: string; url: string; title: string };
export type TurnPromptReference = { kind: 'user-turn'; sessionId: string; turnId: string; messageId: string; title: string };
export type ConversationExtractReference = { kind: 'conversation-extract'; id: string; title: string };
export type SshPromptReference = { kind: 'ssh'; connectionId: string; path: string; title: string };
export type TeamPromptReference = { kind: 'team'; id: string; title: string };
export type ApplicationPromptReference = { kind: 'application'; id: string; title: string; applicationKind: 'builtin' | 'plugin' | 'external' | 'local' | 'web'; target: string; componentId?: string };
export type PromptReference = BrowserPromptReference | TurnPromptReference | ConversationExtractReference | SshPromptReference | ApplicationPromptReference | TeamPromptReference;
export type PromptReferencePart = { text: string; start: number; reference?: PromptReference };

export function promptReferenceHref(reference: PromptReference): string {
  const { kind, ...fields } = reference;
  return `cardbush-reference://${kind}?${new URLSearchParams(Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string')).toString()}`;
}

export function promptReferenceMarkdown(reference: PromptReference): string {
  const title = reference.title.replace(/[\r\n]+/g, ' ').replace(/([\\\[\]])/g, '\\$1');
  return `[@${title}](${promptReferenceHref(reference)})`;
}

export function parsePromptReference(href: string): PromptReference | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'cardbush-reference:' || url.username || url.password || url.port || url.hash || (url.pathname && url.pathname !== '/')) return null;
    const value = (name: string) => url.searchParams.get(name) ?? '';
    const title = value('title');
    const valid = (text: string) => Boolean(text.trim()) && !/[\x00-\x1f\x7f]/.test(text);
    if (!valid(title)) return null;
    if (url.hostname === 'team' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value('id')) && title.length <= 200) {
      return { kind: 'team', id: value('id'), title };
    }
    if (url.hostname === 'application' && valid(value('id')) && value('id').length <= 400 && title.length <= 200) {
      const applicationKind = value('applicationKind'), target = value('target'), id = value('id');
      if (applicationKind === 'builtin' && ['plugins', 'automations', 'settings', 'components'].includes(target) && id === `builtin:${target}`)
        return { kind: 'application', id, title, applicationKind, target };
      if (applicationKind === 'plugin' && valid(target) && valid(value('componentId')) && id === `plugin:${encodeURIComponent(target)}:${encodeURIComponent(value('componentId'))}`)
        return { kind: 'application', id, title, applicationKind, target, componentId: value('componentId') };
      if (applicationKind === 'local' && /^local:[a-z0-9-]{1,80}$/i.test(id) && localApplicationPath(target))
        return { kind: 'application', id, title, applicationKind, target };
      if ((applicationKind === 'external' || applicationKind === 'web') && new RegExp(`^${applicationKind}:[a-z0-9-]{1,80}$`, 'i').test(id) && target.length <= 4096) {
        const address = new URL(target);
        if (['http:', 'https:'].includes(address.protocol) && !address.username && !address.password)
          return { kind: 'application', id, title, applicationKind, target: address.href };
      }
      return null;
    }
    if (url.hostname === 'ssh' && /^[a-z0-9-]+$/.test(value('connectionId')) && value('path').startsWith('/') && valid(value('path'))) return { kind: 'ssh', connectionId: value('connectionId'), path: value('path'), title };
    if (url.hostname === 'conversation-extract' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value('id'))) {
      return { kind: 'conversation-extract', id: value('id'), title };
    }
    if (url.hostname === 'browser' && valid(value('tabId')) && isBrowserReferenceUrl(value('url'))) {
      if (value('pageId') && !/^[1-9]\d{0,9}$/.test(value('pageId'))) return null;
      return { kind: 'browser', tabId: value('tabId'), ...(value('pageId') ? { pageId: value('pageId') } : {}), url: value('url'), title };
    }
    if (url.hostname === 'user-turn' && ['sessionId', 'turnId', 'messageId'].every(name => valid(value(name)))) {
      return { kind: 'user-turn', sessionId: value('sessionId'), turnId: value('turnId'), messageId: value('messageId'), title };
    }
  } catch { /* Unknown or incomplete references remain ordinary text. */ }
  return null;
}

export function isBrowserReferenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' || value === 'about:blank';
  } catch { return false; }
}

export function promptReferenceParts(value: string): PromptReferencePart[] {
  const parts: PromptReferencePart[] = [];
  // Code and escaped links are literal text, not requests to attach context.
  const pattern = /(^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$)[\s\S]*?(?:^[ \t]*\2[`~]*[ \t]*(?:\r?\n|$)|$(?![\s\S])))|(`+)[\s\S]*?\3(?!`)|\[@(?:\\.|[^\]\\\r\n])*\]\((cardbush-reference:\/\/[^\s)]+)\)/gm;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    if (!match[4] || value[match.index - 1] === '!') continue;
    let precedingSlashes = 0;
    while (value[match.index - 1 - precedingSlashes] === '\\') precedingSlashes++;
    if (precedingSlashes % 2) continue;
    const reference = parsePromptReference(match[4]);
    if (!reference) continue;
    if (match.index > cursor) parts.push({ text: value.slice(cursor, match.index), start: cursor });
    parts.push({ text: match[0], start: match.index, reference });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length || !parts.length) parts.push({ text: value.slice(cursor), start: cursor });
  return parts;
}

/** An execution-location change replaces stale SSH chips while retaining the user's draft. */
export function withWorkspaceReference(draft: string, reference?: string): string {
  const content = promptReferenceParts(draft).filter(part => part.reference?.kind !== 'ssh').map(part => part.text).join('');
  return reference ? `${content}${content && !/\s$/.test(content) ? ' ' : ''}${reference} ` : content;
}

export function selectedTeamReference(content: string): TeamPromptReference | undefined {
  return promptReferenceParts(content).flatMap(part => part.reference?.kind === 'team' ? [part.reference] : []).at(-1);
}

/** One explicit workflow per prompt, with the user's other text and references retained. */
export function withTeamReference(draft: string, reference?: TeamPromptReference, caret = draft.length): { content: string; caret: number } {
  const position = Math.max(0, Math.min(caret, draft.length));
  let insertion = position;
  const content = promptReferenceParts(draft).filter(part => {
    if (part.reference?.kind !== 'team') return true;
    insertion -= Math.max(0, Math.min(part.text.length, position - part.start));
    return false;
  }).map(part => part.text).join('');
  const before = content.slice(0, insertion), after = content.slice(insertion);
  const token = reference ? `${before && !/\s$/.test(before) ? ' ' : ''}${promptReferenceMarkdown(reference)}${after.startsWith(' ') ? '' : ' '}` : '';
  return { content: `${before}${token}${after}`, caret: insertion + token.length };
}

export function teamReferenceInstructions(id: string): string {
  return `Selected reusable Team: ${id}. Use the team tool to inspect its definition and run it with explicit task input when appropriate. Team members are registered clean Agents; no parent history is copied.`;
}

/** UI projection of authored text; the canonical model message retains the resolved facts. */
export function authoredPromptContent(content: string, metadata?: Record<string, unknown>): string {
  return typeof metadata?.composerReferenceContent === 'string' ? metadata.composerReferenceContent : content;
}

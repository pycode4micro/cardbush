import { templates } from './generatedTemplates.js';

type TemplateName = keyof typeof templates;
const slot = /\{\{(text|html|json):([a-zA-Z][a-zA-Z0-9]*)\}\}/g;

export function htmlText(value: string | number) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

/** Text is escaped; JSON slots are safe JS literals. HTML requires explicit renderer output. */
export function renderHtmlTemplate(name: TemplateName, text: Record<string, string | number>, html: Record<string, string> = {}) {
  if (!Object.hasOwn(templates, name)) throw new Error(`Unknown HTML template: ${name}`);
  const used = { text: new Set<string>(), html: new Set<string>() };
  const result = templates[name].replace(slot, (_, kind: 'text' | 'html' | 'json', key: string) => {
    const values = kind === 'html' ? html : text;
    if (!Object.hasOwn(values, key)) throw new Error(`Missing ${name} template variable: ${kind}.${key}`);
    used[kind === 'html' ? 'html' : 'text'].add(key);
    if (kind === 'json') return JSON.stringify(values[key]).replace(/[<>&\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    return kind === 'text' ? htmlText(values[key]) : String(values[key]);
  });
  for (const [kind, values] of [['text', text], ['html', html]] as const) {
    for (const key of Object.keys(values)) if (!used[kind].has(key)) throw new Error(`Unexpected ${name} template variable: ${kind}.${key}`);
  }
  return result;
}

import { templates } from './generatedTemplates.js';
import { interpolateTemplate } from './interpolate.js';

type TemplateName = keyof typeof templates;
const slot = /\{\{(text|html|json):([a-zA-Z][a-zA-Z0-9]*)\}\}/g;

export function htmlText(value: string | number) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

/** Text is escaped; JSON slots are safe JS literals. HTML requires explicit renderer output. */
export function renderHtmlTemplate(name: TemplateName, text: Record<string, string | number>, html: Record<string, string> = {}) {
  if (!Object.hasOwn(templates, name)) throw new Error(`Unknown HTML template: ${name}`);
  return interpolateTemplate(templates[name], slot, Object.fromEntries([
    ...Object.entries(text).map(([key, value]) => ['text:' + key, value]),
    ...Object.entries(html).map(([key, value]) => ['html:' + key, value]),
  ]), (value, kind) => {
    if (kind === 'json') return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    return kind === 'text' ? htmlText(String(value)) : String(value);
  }, (kind, key) => (kind === 'json' ? 'text' : kind) + ':' + key);
}

import { prompts } from './generatedPrompts.js';
import { interpolateTemplate } from '../templates/interpolate.js';

/** Model policy is plain text, separate from UI copy and HTML escaping. */
export function renderPromptTemplate(name: keyof typeof prompts, values: Record<string, string | number> = {}) {
  if (!Object.hasOwn(prompts, name)) throw new Error(`Unknown prompt template: ${name}`);
  return interpolateTemplate(prompts[name], /\{\{(value):([a-zA-Z][a-zA-Z0-9]*)\}\}/g,
    Object.fromEntries(Object.entries(values).map(([key, value]) => ['value:' + key, value])), String);
}

export const componentProtocol = 'cardbush.html-surface/1';
export const componentStorageKey = 'cardbush.html_components.v1';
export const maxComponentBytes = 256 * 1024;
type ComponentLayout = { id: string; width: number; height: number; order: number };
export type HtmlComponent = ComponentLayout & { kind?: 'html'; title: string; html: string; allowActions: boolean };
export type BuiltinKind = 'clock' | 'digital-clock' | 'calendar' | 'brand' | 'greeting' | 'suggestions' | 'input';
export type BuiltinComponent = ComponentLayout & { kind: 'builtin'; builtin: BuiltinKind; inputStyle?: 'standard' | 'simple' };
export type ComponentItem = HtmlComponent | BuiltinComponent;
export type WelcomePlacement = { componentId: string; x: number; y: number; width: number; height: number; inputStyle?: 'standard' | 'simple' };
export type WelcomeLayout = { items: WelcomePlacement[] };
export type ComponentCollection = { version: 1; revision: number; items: ComponentItem[]; welcomeLayout?: WelcomeLayout };
export const defaultWelcomeIds = ['system-brand', 'system-greeting', 'system-suggestions', 'system-input'];
const builtinDefinitions: { builtin: BuiltinKind; zh: string; en: string; width: number; height: number }[] = [
  { builtin: 'clock', zh: '时钟', en: 'Clock', width: 4, height: 300 },
  { builtin: 'digital-clock', zh: '数字时钟', en: 'Digital clock', width: 4, height: 300 },
  { builtin: 'calendar', zh: '日历', en: 'Calendar', width: 4, height: 300 },
  { builtin: 'brand', zh: '品牌展示', en: 'Wordmark', width: 8, height: 200 },
  { builtin: 'greeting', zh: '欢迎语', en: 'Greeting', width: 4, height: 200 },
  { builtin: 'suggestions', zh: '对话引导', en: 'Suggestions', width: 12, height: 240 },
  { builtin: 'input', zh: '输入框', en: 'Composer', width: 12, height: 240 },
];
export const isBuiltinComponent = (item: ComponentItem): item is BuiltinComponent => item.kind === 'builtin';
export function componentTitle(item: ComponentItem, language: 'zh' | 'en') {
  return isBuiltinComponent(item) ? builtinDefinitions.find(def => def.builtin === item.builtin)![language] : item.title;
}
export const defaultComponents: ComponentCollection = { version: 1, revision: 0, items: builtinDefinitions.map((def, order) => ({
  id: `system-${def.builtin}`, kind: 'builtin', builtin: def.builtin, width: def.width, height: def.height, order,
  ...(def.builtin === 'input' ? { inputStyle: 'standard' as const } : {}),
})) };

export function normalizeComponents(value: unknown): ComponentCollection {
  const input = value as Partial<ComponentCollection> | null;
  if (!input || input.version !== 1 || !Array.isArray(input.items)) return defaultComponents;
  const seen = new Set<string>();
  const items: ComponentItem[] = input.items.flatMap(item => {
    if (item?.kind === 'builtin' || typeof item?.id === 'string' && item.id.startsWith('system-')) return [];
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(item.id) || seen.has(item.id) ||
      typeof item.html !== 'string' || new TextEncoder().encode(item.html).length > maxComponentBytes) return [];
    seen.add(item.id);
    return [{ id: item.id, title: typeof item.title === 'string' ? item.title.trim().slice(0, 80) || 'HTML' : 'HTML', html: item.html,
      allowActions: item.allowActions === true, width: Math.max(3, Math.min(12, Math.round(Number(item.width) || 6))),
      height: Math.max(120, Math.min(1200, Math.round(Number(item.height) || 280))), order: Number.isFinite(item.order) ? item.order : 0 }];
  }).slice(0, 12);
  // Built-ins are immutable definitions. Only their layout and input presentation are stored.
  // Missing entries are restored, including collections saved before built-ins existed.
  const nextOrder = items.length ? Math.max(...items.map(item => item.order)) + 1 : 0;
  for (const fallback of defaultComponents.items) {
    const saved = input.items.find(item => item?.id === fallback.id && isBuiltinComponent(item));
    items.push({ ...fallback,
      width: saved ? Math.max(3, Math.min(12, Math.round(Number(saved.width) || fallback.width))) : fallback.width,
      height: saved ? Math.max(120, Math.min(1200, Math.round(Number(saved.height) || fallback.height))) : fallback.height,
      order: saved && Number.isFinite(saved.order) ? saved.order : nextOrder + fallback.order,
      ...(isBuiltinComponent(fallback) && fallback.builtin === 'input' ? { inputStyle: saved && isBuiltinComponent(saved) && saved.inputStyle === 'simple' ? 'simple' as const : 'standard' as const } : {}),
    });
  }
  return { version: 1, revision: Math.max(0, Math.floor(Number(input.revision) || 0)), items: items.sort((a, b) => a.order - b.order),
    ...(input.welcomeLayout && Array.isArray(input.welcomeLayout.items) ? { welcomeLayout: normalizeWelcomeLayout(input.welcomeLayout, items) } : {}) };
}

function normalizeWelcomeLayout(layout: WelcomeLayout, catalog: ComponentItem[]): WelcomeLayout {
  const seen = new Set<string>();
  const bounded = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return { items: layout.items.flatMap(item => {
    if (!item || seen.has(item.componentId) || !catalog.some(component => component.id === item.componentId)) return [];
    seen.add(item.componentId);
    const width = bounded(item.width, 50, 10, 100);
    return [{ componentId: item.componentId, x: bounded(item.x, 0, 0, 100 - width), y: bounded(item.y, 0, 0, 10000), width,
      height: bounded(item.height, 200, 20, 1200), ...(item.inputStyle ? { inputStyle: item.inputStyle === 'simple' ? 'simple' as const : 'standard' as const } : {}) }];
  }) };
}

export function validateComponentText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > 32000) throw new Error('INVALID_ARGUMENT');
  return value;
}

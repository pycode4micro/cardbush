import type { MessageKey } from '../../i18n';
import { uiText } from '../../i18n';
export const componentProtocol = 'cardbush.html-surface/1';
export const componentStorageKey = 'cardbush.html_components.v1';
export const maxComponentBytes = 256 * 1024;
type ComponentLayout = { id: string; width: number; height: number; order: number };
export type ComposerFlow = { afterSend: 'bottom' | 'keep'; output: 'above' | 'below' };
type ComposerFlowOptions = { composerFlow?: ComposerFlow };
export type HtmlComponent = ComponentLayout & { kind?: 'html'; title: string; html: string; allowActions: boolean };
export type BuiltinKind = 'clock' | 'digital-clock' | 'calendar' | 'brand' | 'greeting' | 'suggestions' | 'input';
export type BuiltinComponent = ComponentLayout & ComposerFlowOptions & { kind: 'builtin'; builtin: BuiltinKind; inputStyle?: 'standard' | 'simple' };
export type ComponentItem = HtmlComponent | BuiltinComponent;
export type WelcomePlacement = ComposerFlowOptions & { componentId: string; x: number; y: number; width: number; height: number; inputStyle?: 'standard' | 'simple'; composerDock?: 'bottom' };
export type WelcomeLayout = { items: WelcomePlacement[]; viewportHeight?: number };
export type ComponentCollection = { version: 1; revision: number; items: ComponentItem[]; welcomeLayout?: WelcomeLayout };
export const defaultWelcomeIds = ['system-brand', 'system-greeting', 'system-suggestions', 'system-input'];
const builtinDefinitions: { builtin: BuiltinKind; width: number; height: number; labelKey: MessageKey }[] = [
  { builtin: 'clock', width: 4, height: 300, labelKey: 'componentModel.clock' as const },
  { builtin: 'digital-clock', width: 4, height: 300, labelKey: 'componentModel.digital_clock' as const },
  { builtin: 'calendar', width: 4, height: 300, labelKey: 'componentModel.calendar' as const },
  { builtin: 'brand', width: 8, height: 200, labelKey: 'componentModel.wordmark' as const },
  { builtin: 'greeting', width: 4, height: 200, labelKey: 'componentModel.greeting' as const },
  { builtin: 'suggestions', width: 12, height: 240, labelKey: 'componentModel.suggestions' as const },
  { builtin: 'input', width: 12, height: 240, labelKey: 'componentModel.composer' as const },
];
export const isBuiltinComponent = (item: ComponentItem): item is BuiltinComponent => item.kind === 'builtin';
export function componentTitle(item: ComponentItem, language: string) {
  return isBuiltinComponent(item) ? uiText(language)(builtinDefinitions.find(def => def.builtin === item.builtin)!.labelKey) : item.title;
}
export const defaultComponents: ComponentCollection = { version: 1, revision: 0, items: builtinDefinitions.map((def, order) => ({
  id: `system-${def.builtin}`, kind: 'builtin', builtin: def.builtin, width: def.width, height: def.height, order,
  ...(def.builtin === 'input' ? { inputStyle: 'standard' as const } : {}),
})) };

export function welcomeInputStyle(collection: ComponentCollection): 'standard' | 'simple' {
  const input = collection.items.find(item => isBuiltinComponent(item) && item.builtin === 'input');
  if (!input || !isBuiltinComponent(input)) return 'standard';
  return collection.welcomeLayout?.items.find(item => item.componentId === input.id)?.inputStyle ?? input.inputStyle ?? 'standard';
}

export function normalizeComposerFlow(value: unknown): ComposerFlow {
  const flow = value as Partial<ComposerFlow> | null;
  return { afterSend: flow?.afterSend === 'keep' ? 'keep' : 'bottom', output: flow?.output === 'below' ? 'below' : 'above' };
}

export function welcomeComposerFlow(collection: ComponentCollection): ComposerFlow {
  const input = collection.items.find(item => isBuiltinComponent(item) && item.builtin === 'input');
  return normalizeComposerFlow(collection.welcomeLayout?.items.find(item => item.componentId === input?.id)?.composerFlow
    ?? (input && isBuiltinComponent(input) ? input.composerFlow : undefined));
}

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
      ...(isBuiltinComponent(fallback) && fallback.builtin === 'input' ? {
        inputStyle: saved && isBuiltinComponent(saved) && saved.inputStyle === 'simple' ? 'simple' as const : 'standard' as const,
        ...(saved && isBuiltinComponent(saved) && saved.composerFlow ? { composerFlow: normalizeComposerFlow(saved.composerFlow) } : {}),
      } : {}),
    });
  }
  return { version: 1, revision: Math.max(0, Math.floor(Number(input.revision) || 0)), items: items.sort((a, b) => a.order - b.order),
    ...(input.welcomeLayout && Array.isArray(input.welcomeLayout.items) ? { welcomeLayout: normalizeWelcomeLayout(input.welcomeLayout, items) } : {}) };
}

function normalizeWelcomeLayout(layout: WelcomeLayout, catalog: ComponentItem[]): WelcomeLayout {
  const seen = new Set<string>();
  const bounded = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return { ...(typeof layout.viewportHeight === 'number' && Number.isFinite(layout.viewportHeight) && layout.viewportHeight > 0
    ? { viewportHeight: bounded(layout.viewportHeight, 1, 1, 10000) } : {}), items: layout.items.flatMap(item => {
    if (!item || seen.has(item.componentId) || !catalog.some(component => component.id === item.componentId)) return [];
    seen.add(item.componentId);
    const width = bounded(item.width, 50, 10, 100);
    return [{ componentId: item.componentId, x: item.componentId === 'system-input' ? (100 - width) / 2 : bounded(item.x, 0, 0, 100 - width), y: bounded(item.y, 0, 0, 10000), width,
      height: bounded(item.height, 200, 20, 1200), ...(item.inputStyle ? { inputStyle: item.inputStyle === 'simple' ? 'simple' as const : 'standard' as const } : {}),
      ...(item.componentId === 'system-input' && item.composerDock === 'bottom' ? { composerDock: 'bottom' as const } : {}),
      ...(item.componentId === 'system-input' && item.composerFlow ? { composerFlow: normalizeComposerFlow(item.composerFlow) } : {}) }];
  }) };
}

export function validateComponentText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > 32000) throw new Error('INVALID_ARGUMENT');
  return value;
}

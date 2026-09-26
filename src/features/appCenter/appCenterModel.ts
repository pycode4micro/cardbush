import type { AppLanguage, CardbushAppPlugin } from '../../types';
import type { ApplicationPromptReference } from '../../shared/promptReferences';
import { normalizeLocalApplications, type LocalApplication } from '../../shared/localApplications';

export type AppCenterPreferences = { shortcuts: string[]; display: 'always' | 'hover'; links: Array<{ id: string; title: string; url: string }>; localApps?: LocalApplication[]; order?: string[] };
export const defaultAppCenterPreferences: AppCenterPreferences = { shortcuts: ['builtin:plugins', 'builtin:automations'], display: 'always', links: [] };
export type ApplicationEntry = { id: string; title: string; description: string; kind: 'builtin' | 'plugin' | 'external' | 'local'; icon?: string;
  target: string; plugin?: CardbushAppPlugin; componentId?: string; launch?: NonNullable<CardbushAppPlugin['components'][number]['app']>; shortcut?: 'openSettings' | 'openPlugins' | 'openAutomations' };

export function applicationLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* Invalid links are not launchable. */ }
}

export function normalizeAppCenterPreferences(value: unknown): AppCenterPreferences {
  if (!value || typeof value !== 'object') return defaultAppCenterPreferences;
  const input = value as Partial<AppCenterPreferences>, ids = new Set<string>();
  const links = (Array.isArray(input.links) ? input.links : []).flatMap(link => {
    if (!link || typeof link.id !== 'string' || !/^external:[a-z0-9-]{1,80}$/i.test(link.id) || ids.has(link.id) || typeof link.title !== 'string' || !link.title.trim()) return [];
    const url = applicationLink(link.url); if (!url) return [];
    ids.add(link.id); return [{ id: link.id, title: link.title.trim().slice(0, 80), url }];
  }).slice(0, 100);
  return { display: input.display === 'hover' ? 'hover' : 'always', links,
    ...(Array.isArray(input.localApps) ? { localApps: normalizeLocalApplications(input.localApps) } : {}),
    ...(Array.isArray(input.order) ? { order: [...new Set(input.order.filter(id => typeof id === 'string' && /^(builtin|plugin|external|local):/.test(id) && id.length <= 400))].slice(0, 200) } : {}),
    shortcuts: Array.isArray(input.shortcuts) ? [...new Set(input.shortcuts.filter(id => typeof id === 'string' && /^(builtin|plugin|external|local):/.test(id) && id.length <= 400))].slice(0, 4) : defaultAppCenterPreferences.shortcuts };
}

export function applicationCatalog(language: AppLanguage, plugins: CardbushAppPlugin[], prefs: AppCenterPreferences): ApplicationEntry[] {
  const zh = language === 'zh';
  const entries: ApplicationEntry[] = [
    { id: 'builtin:plugins', kind: 'builtin', target: 'plugins', title: zh ? '插件' : 'Plugins', description: zh ? '发现与管理技能、工具和插件' : 'Discover and manage skills, tools and plugins', shortcut: 'openPlugins' },
    { id: 'builtin:automations', kind: 'builtin', target: 'automations', title: zh ? '定时与自动化' : 'Automations', description: zh ? '日历、定时任务与执行结果' : 'Calendar, scheduled tasks and results', shortcut: 'openAutomations' },
    { id: 'builtin:settings', kind: 'builtin', target: 'settings', title: zh ? '设置' : 'Settings', description: zh ? '模型、连接、外观和偏好' : 'Models, connections, appearance and preferences', shortcut: 'openSettings' },
    ...plugins.filter(plugin => plugin.installed && plugin.enabled && !plugin.removalPending).flatMap(plugin => plugin.components.filter(component => component.kind === 'app' && (
      component.app?.kind === 'url' ? Boolean(applicationLink(component.app.url)) : component.app?.kind === 'renderer' && component.app.extensionId === plugin.id
    )).map(component => ({
      id: `plugin:${encodeURIComponent(plugin.id)}:${encodeURIComponent(component.id)}`, kind: 'plugin' as const, target: plugin.id, componentId: component.id, plugin,
      title: component.name || plugin.name, description: component.description || plugin.name, launch: component.app,
    }))),
    ...prefs.links.map(link => ({ id: link.id, kind: 'external' as const, target: link.url, title: link.title, description: new URL(link.url).host })),
    ...(prefs.localApps ?? []).map(app => ({ id: app.id, kind: 'local' as const, target: app.path, title: app.title, description: app.path, icon: app.icon })),
  ];
  const order = new Map((prefs.order ?? []).map((id, index) => [id, index]));
  return entries.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
}

export function moveApplication(ids: string[], id: string, target?: string): string[] {
  if (id === target) return ids;
  const next = ids.filter(value => value !== id), index = target ? next.indexOf(target) : -1;
  next.splice(index < 0 ? next.length : index, 0, id);
  return next;
}

export function applicationReference(app: ApplicationEntry): ApplicationPromptReference {
  return { kind: 'application', id: app.id, title: app.title, applicationKind: app.kind, target: app.target,
    ...(app.componentId ? { componentId: app.componentId } : {}) };
}

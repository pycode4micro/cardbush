/** Portable metadata for a website installed into the host application's catalog. */
export type WebApplicationInfo = { identity: string; title: string; url: string; scope: string; icon?: string; manifestUrl?: string };
export type WebApplication = WebApplicationInfo & { id: string };

function webUrl(value: unknown, base?: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return '';
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
function sameOrigin(value: unknown, base: string, origin: string) {
  const url = webUrl(value, base);
  return url && new URL(url).origin === origin ? url : '';
}
function text(value: unknown) { return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80) : ''; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** Process only launch metadata; a manifest cannot grant native/plugin permissions. */
export function websiteApplication(pageUrl: string, pageTitle: string, value: unknown = {}): WebApplicationInfo | null {
  const page = webUrl(pageUrl); if (!page) return null;
  const origin = new URL(page).origin, input = record(value), manifestUrl = webUrl(input.manifestUrl);
  const manifest = manifestUrl ? record(input.manifest) : {};
  const hasManifest = Boolean(manifestUrl && Object.keys(manifest).length);
  const url = sameOrigin(manifest.start_url, manifestUrl, origin) || page;
  const identity = new URL(sameOrigin(manifest.id, origin + '/', origin) || url); identity.hash = '';
  const defaultScope = new URL('.', url).href;
  const scope = new URL(sameOrigin(manifest.scope, manifestUrl, origin) || defaultScope); scope.search = ''; scope.hash = '';
  const icons = (Array.isArray(manifest.icons) ? manifest.icons : []).slice(0, 64).map(record)
    .filter(icon => !icon.purpose || typeof icon.purpose === 'string' && icon.purpose.split(/\s+/).includes('any'));
  icons.sort((a, b) => {
    const size = (icon: Record<string, unknown>) => typeof icon.sizes === 'string' && icon.sizes.split(/\s+/).includes('any') ? 512 : Math.max(0, ...String(icon.sizes ?? '').split(/\s+/).map(s => Math.min(512, Number(s.split('x')[0]) || 0)));
    return size(b) - size(a);
  });
  const icon = icons.map(icon => webUrl(icon.src, manifestUrl)).find(Boolean) || webUrl(input.icon, page);
  return { identity: identity.href, title: text(manifest.name) || text(manifest.short_name) || text(pageTitle) || new URL(page).host,
    url, scope: new URL(url).pathname.startsWith(scope.pathname) ? scope.href : defaultScope,
    ...(icon ? { icon } : {}), ...(hasManifest ? { manifestUrl } : {}) };
}

export function normalizeWebApplications(value: unknown): WebApplication[] {
  const ids = new Set<string>(), identities = new Set<string>();
  return (Array.isArray(value) ? value : []).flatMap(item => {
    const input = record(item), url = webUrl(input.url), id = typeof input.id === 'string' ? input.id : '', title = text(input.title);
    if (!/^web:[a-z0-9-]{1,80}$/i.test(id) || !url || !title || ids.has(id)) return [];
    const origin = new URL(url).origin, identity = new URL(sameOrigin(input.identity, url, origin) || url); identity.hash = '';
    if (identities.has(identity.href)) return [];
    const scope = new URL(sameOrigin(input.scope, url, origin) || new URL('.', url).href); scope.search = ''; scope.hash = '';
    const icon = webUrl(input.icon), manifestUrl = webUrl(input.manifestUrl);
    ids.add(id); identities.add(identity.href);
    return [{ id, identity: identity.href, title, url, scope: new URL(url).pathname.startsWith(scope.pathname) ? scope.href : new URL('.', url).href,
      ...(icon ? { icon } : {}), ...(manifestUrl ? { manifestUrl } : {}) }];
  });
}

export function webApplicationMatches(app: WebApplication, address: string): boolean {
  const href = webUrl(address); if (!href) return false;
  const url = new URL(href); url.hash = '';
  const start = new URL(app.url); start.hash = '';
  if (url.href === start.href) return true;
  const scope = new URL(app.scope);
  return Boolean(app.manifestUrl && url.origin === scope.origin && url.pathname.startsWith(scope.pathname));
}

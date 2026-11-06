import { uiText } from '../../i18n';
import { renderHtmlTemplate } from '@cardbush/platform/templates';
/** The frame has an opaque origin. No credentials, host paths or runtime tokens cross this bridge. */
export type McpAppView = { token: string; html: string; meta: Record<string, any>; title?: string; serverTitle?: string; tool: Record<string, unknown>; input: unknown; result: any };
export function mcpAppTheme(element: Element | null = document.querySelector('.app')): 'light' | 'dark' {
  return getComputedStyle(element ?? document.documentElement).colorScheme.split(' ').includes('dark') ? 'dark' : 'light';
}
/** MCP Apps host style variables, derived from the active CardBush palette. */
export function mcpAppStyleVariables(element: Element | null = document.querySelector('.app')): Record<string, string> {
  const style = getComputedStyle(element ?? document.documentElement);
  const palette = { '--color-background-primary': '--surface', '--color-background-secondary': '--surface-raised',
    '--color-text-primary': '--text', '--color-text-secondary': '--text-mid', '--color-text-tertiary': '--text-soft',
    '--color-border-primary': '--border', '--color-border-secondary': '--border', '--color-ring-primary': '--accent',
    '--color-background-info': '--accent', '--color-text-info': '--text',
    '--cardbush-accent': '--accent', '--cardbush-text': '--text', '--cardbush-surface': '--surface' };
  return { ...Object.fromEntries(Object.entries(palette).map(([key, property]) => [key, style.getPropertyValue(property).trim()]).filter(([, value]) => value)),
    '--font-sans': style.fontFamily, '--font-mono': 'ui-monospace, Consolas, monospace',
    '--font-text-md-size': '14px', '--font-text-sm-size': '13px', '--border-radius-sm': '6px', '--border-radius-md': '8px', '--border-radius-lg': '12px' };
}
function origins(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter((item): item is string => typeof item === 'string' && /^https?:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/i.test(item) || typeof item === 'string' && /^wss:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(item)).join(' ');
}
export function mcpAppDocument(view: McpAppView, language: string, theme = mcpAppTheme(), variables = mcpAppStyleVariables()): string {
  const csp = view.meta.ui?.csp ?? {};
  const legacy = view.meta['openai/widgetCSP'] ?? {};
  const resources = origins(csp.resourceDomains ?? legacy.resource_domains);
  const policy = `default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: blob: ${resources}; font-src data: ${resources}; media-src blob: ${resources}; connect-src ${origins(csp.connectDomains ?? legacy.connect_domains) || "'none'"}; frame-src ${origins(csp.frameDomains ?? legacy.frame_domains) || "'none'"}; base-uri ${origins(csp.baseUriDomains) || "'none'"}; form-action 'none'; object-src 'none'`;
  const initial = JSON.stringify({ toolInput: view.input, toolOutput: view.result?.structuredContent ?? view.result, toolResponseMetadata: view.result?._meta ?? {}, widgetState: null, locale: language, theme, styles: { variables }, displayMode: 'inline', maxHeight: 900 }).replaceAll('<', '\\u003c');
  const shim = renderHtmlTemplate('mcp-app-bridge', { theme: theme === 'dark' ? 'dark' : 'light', variables: JSON.stringify(variables), initial, timeout: uiText(language)('mcpAppBridge.requestTimedOut'), canvasStyle: renderHtmlTemplate('mcp-app-canvas', {}) });
  // CSP is the first parsed element and cannot be relaxed by resource-provided markup.
  return renderHtmlTemplate('mcp-app-document', { policy }, { bridge: shim, provider: view.html });
}

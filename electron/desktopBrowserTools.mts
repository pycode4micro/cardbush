import { z } from 'zod';
import type { ToolRegistry } from '@cardbush/bush-runtime';
import type { McpHostBridge } from './mcpHostBridge.js';
import { checkedExternalWebUrl } from './externalWebUrl.js';

const inputSchema = z.object({ url: z.string().min(1).max(8192) }).strict();

/** The desktop owns navigation; the Runtime never launches or owns the browser process. */
export function registerDesktopBrowserTools(registry: ToolRegistry, bridge: Pick<McpHostBridge, 'request'>): void {
  registry.register<{ url: string }>({
    definition: {
      name: 'open_external_url',
      description: 'Open an HTTP(S) webpage in the user’s system default browser when the user wants to view or keep it open (for example a livestream). The desktop launches it independently of terminal/turn cleanup; do not use terminal_exec, Start-Process or shell start for this. This only requests navigation: it does not verify page loading, select a browser/profile, grant website access, or provide page control. Use Browser Use for reading/clicking/automation, and honor a specified browser/profile instead of silently switching to the default. Do not automatically retry an interrupted request: a page may already have opened.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['url'], properties: {
        url: { type: 'string', minLength: 1, maxLength: 8192, description: 'Absolute HTTP(S) webpage URL without embedded credentials.' },
      } },
    },
    manifest: { effect_kind: 'mutation', operation: 'browser.open_external', risk: 'low', owner: 'desktop', dispatch_scope: 'session', mutating: true },
    executionChannel: 'desktop:browser',
    decodeInput: value => ({ url: checkedExternalWebUrl(inputSchema.parse(value).url) }),
    execute: async context => {
      context.signal?.throwIfAborted();
      return bridge.request('browser.open-external', context.input, context.signal);
    },
  });
}

import { z } from 'zod';
import type { ToolRegistry } from '@cardbush/bush-runtime';
import type { McpHostBridge } from './mcpHostBridge.js';
import { browserActionSchema, computerActionSchema } from './agentDesktopSchema.mjs';

export function registerAgentDesktopTools(registry: ToolRegistry, bridge: Pick<McpHostBridge, 'request'>) {
  const common = 'Acts only on this Personal Agent’s isolated Linux desktop, never the connecting user’s computer. The desktop and browser persist after tools/turns finish. Stop when the user takes control; never bypass takeover via terminal, CDP or another tool. Use one action at a time, inspect results, and do not replay an action with an uncertain outcome. Do not close pages unless requested. ';
  for (const [name, tool, schema, description] of [
    ['linux_computer_use', 'computer', computerActionSchema, 'Observe to get an original-resolution desktop screenshot and stateId. Coordinates are pixels in that image. Every input requires its fresh stateId, from this session/turn; a state is single use. Supports click, drag, scroll, key and Unicode type. Keys use X11 names, e.g. Return, ctrl+l. Observe again after each input.'],
    ['linux_browser_use', 'browser', browserActionSchema, 'Uses the same visible Chromium profile as the desktop. Start with tabs or open(url). Use snapshot(tabId) for visible element indices or screenshot(tabId) for an image. Mutations require stateId from a fresh snapshot/screenshot of that tab; click/fill additionally require a snapshot element index. Navigate/open accept HTTP(S) only. key uses Playwright key names (Enter, Control+l); scroll requires direction. Browser screenshots use page viewport pixels, not desktop coordinates; use linux_computer_use.observe for desktop clicking.'],
  ] as const) registry.register({
    definition: { name, description: common + description, inputSchema: z.toJSONSchema(schema) },
    manifest: { effect_kind: 'mutation', operation: `desktop.${tool}`, risk: 'medium', owner: 'agent', dispatch_scope: 'session', mutating: true },
    executionChannel: 'agent:desktop',
    decodeInput: value => schema.parse(value),
    execute: context => bridge.request('agent.desktop.tool', { sessionId: context.sessionId, turnId: context.turnId, tool, input: context.input }, context.signal, true),
  });
}

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { executeComputerUse, type ComputerUseArtifact } from './computerUseRuntime.js';
import type { ComputerUsePluginConfig } from '../config.js';

const inputSchema = z.object({
  action: z.enum([
    'observe',
    'screenshot',
    'click',
    'type',
    'key',
    'scroll',
    'drag',
    'window',
    'open_app',
  ]),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  to_x: z.number().int().optional(),
  to_y: z.number().int().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clicks: z.number().int().min(1).max(5).optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  keys: z.array(z.string()).min(1).optional(),
  delta: z.number().int().min(-20).max(20).optional(),
  duration_ms: z.number().int().min(0).max(5000).optional(),
  steps: z.number().int().min(1).max(120).optional(),
  title_pattern: z.string().optional().describe('Case-insensitive substring of the window title.'),
  hwnd: z.number().int().positive().optional(),
  operation: z.enum([
    'activate',
    'focus',
    'minimize',
    'maximize',
    'restore',
    'close',
    'move',
    'resize',
  ]).optional(),
  app: z.string().optional().describe(
    'Application executable or process name, such as chrome, msedge, or code. Supported by open_app and window actions.',
  ),
}).superRefine((input, context) => {
  const requireFields = (fields: Array<keyof typeof input>, message: string) => {
    for (const field of fields) {
      if (input[field] == null || input[field] === '') {
        context.addIssue({ code: 'custom', path: [field], message });
      }
    }
  };
  if (input.action === 'click') {
    requireFields(['x', 'y'], 'click requires x and y.');
  }
  if (input.action === 'drag') {
    requireFields(['x', 'y', 'to_x', 'to_y'], 'drag requires x, y, to_x, and to_y.');
  }
  if (input.action === 'type' && input.text == null) {
    context.addIssue({ code: 'custom', path: ['text'], message: 'type requires text.' });
  }
  if (input.action === 'key' && !input.key?.trim() && !input.keys?.length) {
    context.addIssue({ code: 'custom', path: ['key'], message: 'key requires key or keys.' });
  }
  if (input.action === 'scroll') {
    requireFields(['delta'], 'scroll requires delta.');
  }
  if (input.action === 'open_app' && !input.app?.trim()) {
    context.addIssue({
      code: 'custom',
      path: ['app'],
      message: 'open_app requires app.',
    });
  }
  if (
    input.action === 'window' &&
    input.hwnd == null &&
    !input.title_pattern?.trim() &&
    !input.app?.trim()
  ) {
    context.addIssue({
      code: 'custom',
      path: ['app'],
      message: 'window requires app, title_pattern, or hwnd.',
    });
  }
  if (input.action === 'window' && input.operation === 'move') {
    requireFields(['x', 'y'], 'window move requires x and y.');
  }
  if (input.action === 'window' && input.operation === 'resize') {
    requireFields(['width', 'height'], 'window resize requires width and height.');
  }
});

export function registerComputerUsePlugin(
  server: McpServer,
  config: ComputerUsePluginConfig,
): void {
  server.registerTool('computer_use', {
    title: 'Computer use',
    description: [
      "Observe and interact with the user's current desktop through visible application UI.",
      "Input actions may occupy the user's mouse or keyboard. Screenshots are returned as image artifacts.",
      'Window actions accept app, title_pattern, or an exact hwnd returned by observe.',
    ].join(' '),
    annotations: {
      title: 'Computer Use',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema,
    _meta: {
      'cardbush/plugin_id': 'computer_use',
    },
  }, async (input, context) => {
    try {
      const result = await executeComputerUse(input, config, context.mcpReq.signal);
      return mcpResult(
        true,
        result.output,
        result.paths,
        result.artifacts,
        input.action,
      );
    } catch (error) {
      if (context.mcpReq.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      return mcpResult(
        false,
        {},
        [],
        [],
        input.action,
        { code: 'computer_use_failed', message: errorMessage(error) },
      );
    }
  });
}

function mcpResult(
  success: boolean,
  output: unknown,
  paths: string[],
  artifacts: ComputerUseArtifact[],
  action: string,
  error?: { code: string; message: string },
) {
  const result = { action, output, paths, artifacts, ...(error ? { error } : {}) };
  return {
    content: [{
      type: 'text' as const,
      text: success ? JSON.stringify(output) : error?.message ?? 'computer_use failed',
    }],
    structuredContent: result,
    isError: !success,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { executeComputerUse, type ComputerUseArtifact } from './computerUseRuntime.js';
import type { ComputerUsePluginConfig } from '../config.js';

const inputSchema = z.object({
  action: z.enum([
    'observe',
    'screenshot',
    'click',
    'invoke',
    'set_value',
    'type',
    'key',
    'scroll',
    'drag',
    'window',
    'open_app',
    'finish',
  ]),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  to_x: z.number().int().optional(),
  to_y: z.number().int().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clicks: z.number().int().min(1).max(5).optional(),
  state_id: z.string().trim().min(1).max(160).optional().describe(
    'One-use state identifier returned by a target-specific observe call. Required for every action against an existing window.',
  ),
  element_index: z.number().int().min(0).optional().describe(
    'Accessibility element index returned by the target-specific observe call. Prefer this over coordinates.',
  ),
  value: z.string().max(8192).optional(),
  text: z.string().max(8192).optional(),
  key: z.string().trim().min(1).max(64).optional(),
  keys: z.array(z.string().trim().min(1).max(64)).min(1).max(8).optional(),
  delta: z.number().int().min(-20).max(20).optional(),
  duration_ms: z.number().int().min(0).max(1500).optional(),
  steps: z.number().int().min(1).max(120).optional(),
  title_pattern: z.string().trim().max(512).optional().describe('Case-insensitive substring of the window title.'),
  hwnd: z.number().int().positive().optional().describe(
    'Exact top-level window handle returned by observe. For input actions, rejects the action if the visible target changed.',
  ),
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
  app: z.string().trim().max(1024).optional().describe(
    'Application executable or process name, such as chrome, msedge, or code. Supported by open_app and window actions.',
  ),
  max_elements: z.number().int().min(20).max(300).optional().describe(
    'Maximum accessibility elements returned by a target-specific observe call. Defaults to 160.',
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
    if (input.element_index == null) {
      requireFields(['x', 'y'], 'click requires element_index or window-relative x and y.');
    } else {
      if (input.x != null || input.y != null) {
        context.addIssue({
          code: 'custom',
          path: ['element_index'],
          message: 'click accepts either element_index or coordinates, not both.',
        });
      }
      if ((input.button && input.button !== 'left') || (input.clicks != null && input.clicks !== 1)) {
        context.addIssue({
          code: 'custom',
          path: ['button'],
          message: 'Semantic element clicks perform the default action once. Use coordinates for another button or click count.',
        });
      }
    }
  }
  if (input.action === 'drag') {
    requireFields(['x', 'y', 'to_x', 'to_y'], 'drag requires x, y, to_x, and to_y.');
  }
  if (input.action === 'type' && input.text == null) {
    context.addIssue({ code: 'custom', path: ['text'], message: 'type requires text.' });
  }
  if (input.action === 'invoke' && input.element_index == null) {
    context.addIssue({ code: 'custom', path: ['element_index'], message: 'invoke requires element_index.' });
  }
  if (input.action === 'set_value') {
    if (input.element_index == null) {
      context.addIssue({ code: 'custom', path: ['element_index'], message: 'set_value requires element_index.' });
    }
    if (input.value == null) {
      context.addIssue({ code: 'custom', path: ['value'], message: 'set_value requires value.' });
    }
  }
  if (input.action === 'key' && !input.key?.trim() && !input.keys?.length) {
    context.addIssue({ code: 'custom', path: ['key'], message: 'key requires key or keys.' });
  }
  if (input.action === 'scroll') {
    requireFields(['x', 'y', 'delta'], 'scroll requires window-relative x, y, and delta.');
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
  if (
    ['click', 'invoke', 'set_value', 'type', 'key', 'scroll', 'drag', 'window'].includes(input.action)
  ) {
    if (!input.state_id?.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['state_id'],
        message: `${input.action} requires state_id from a target-specific observe call.`,
      });
    }
    if (input.hwnd == null) {
      context.addIssue({
        code: 'custom',
        path: ['hwnd'],
        message: `${input.action} requires the exact hwnd returned with state_id.`,
      });
    }
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
      "Input shares the user's mouse and keyboard, yields while the user is active, and restores the pointer after mouse actions by default.",
      'Call observe once to discover windows, then observe an exact hwnd to receive a one-use state_id, a window screenshot, and accessibility elements.',
      'Every action against an existing window must include that state_id and hwnd. The state is consumed after one action and becomes stale if another turn changes the desktop.',
      'Click with element_index, invoke, and set_value use UI Automation without moving the pointer. Coordinates are window-relative and remain available when an element has no semantic action.',
      'Screenshots are returned as image artifacts.',
      'Call finish when desktop work is complete or abandoned to release the window border and stop control. A user stop ends desktop control for this turn.',
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
      const result = await executeComputerUse(
        input,
        config,
        context.mcpReq.signal,
        safetyScope(context.mcpReq._meta),
      );
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

function safetyScope(metadata: Record<string, unknown> | undefined): string {
  const sessionId = typeof metadata?.cardbush_session_id === 'string'
    ? metadata.cardbush_session_id.trim().slice(0, 160)
    : '';
  const turnId = typeof metadata?.cardbush_turn_id === 'string'
    ? metadata.cardbush_turn_id.trim().slice(0, 160)
    : '';
  return sessionId && turnId ? JSON.stringify([sessionId, turnId]) : sessionId || 'unscoped';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

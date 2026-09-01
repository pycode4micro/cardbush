import {
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  type Artifact,
  type ToolResult,
} from '@cardbush/bush-protocol';
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { executeComputerUse } from './computerUseRuntime.js';
import type { ComputerUsePluginConfig } from '../config.js';

export const computerUseManifest = {
  effect_kind: 'desktop_control',
  operation: 'desktop.control',
  risk: 'medium',
  owner: 'cardbush_apps',
  dispatch_phase: 'execution',
  dispatch_scope: 'process',
  dispatch_side_effect: 'desktop_control',
  dispatch_mutating: true,
  dispatch_source: 'mcp_tool',
  stage_modes: ['execute'],
  output_kinds: ['structured_data', 'artifact'],
  handoff_exports: ['artifact'],
  evidence_hints: ['desktop_state', 'screenshot'],
} as const;

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
      'cardbush/action_manifest': computerUseManifest,
    },
  }, async (input, context) => {
    try {
      const result = await executeComputerUse(input, config, context.mcpReq.signal);
      return mcpResult(
        context,
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
        context,
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
  context: ServerContext,
  success: boolean,
  output: unknown,
  paths: string[],
  artifacts: Artifact[],
  action: string,
  error?: { code: string; message: string },
) {
  const metadata = (context.mcpReq._meta ?? {}) as Record<string, unknown>;
  const receiptId = requiredMetadata(metadata, 'receipt_id');
  const toolCallId = requiredMetadata(metadata, 'tool_call_id');
  const actionManifest = record(metadata.action_manifest);
  const manifestId = requiredMetadata(actionManifest, 'manifest_id');
  const result: ToolResult = {
    protocol: BUSH_TOOL_RESULT_PROTOCOL,
    tool_call_id: toolCallId,
    success,
    output,
    facts: [{
      protocol: BUSH_EXECUTION_FACT_PROTOCOL,
      receipt_id: receiptId,
      action_manifest_id: manifestId,
      status: success ? 'succeeded' : 'failed',
      operation: String(actionManifest.operation ?? computerUseManifest.operation),
      effect_kind: String(actionManifest.effect_kind ?? computerUseManifest.effect_kind),
      owner: String(actionManifest.owner ?? computerUseManifest.owner),
      dispatch_scope: String(actionManifest.dispatch_scope ?? computerUseManifest.dispatch_scope),
      categories: ['desktop_control'],
      paths,
      execution_success: success,
      semantic_success: success,
      verification_state: success
        ? ['observe', 'list_windows'].includes(action) ? 'verified' : 'attempted'
        : 'failed',
      error_code: error?.code ?? '',
    }],
    artifacts,
    workspace_changes: [],
    guidance: [],
    ...(error ? { error: { kind: 'tool' as const, ...error } } : {}),
  };
  return {
    content: [{
      type: 'text' as const,
      text: success ? JSON.stringify(output) : error?.message ?? 'computer_use failed',
    }],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: !success,
  };
}

function requiredMetadata(value: Record<string, unknown>, key: string): string {
  const result = String(value[key] ?? '').trim();
  if (!result) throw new Error(`Missing CardBush MCP request metadata: ${key}`);
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

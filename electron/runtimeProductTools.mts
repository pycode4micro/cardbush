import {
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  type Artifact,
  type ToolResult,
} from '@cardbush/bush-protocol';
import {
  type ToolAdmissionContext,
  type ToolHandlerContext,
  type ToolRegistry,
} from '@cardbush/bush-runtime';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export interface ProductHostToolRequest {
  toolName: string;
  input: unknown;
  context: {
    sessionId: string;
    turnId: string;
    toolCallId: string;
    capabilityIds: string[];
  };
  signal?: AbortSignal;
}

export interface ProductHostToolResponse {
  success: boolean;
  output: unknown;
  artifacts?: Artifact[];
  paths?: string[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export function registerProductHostTools(
  registry: ToolRegistry,
  invoke: (request: ProductHostToolRequest) => Promise<ProductHostToolResponse>,
): void {
  registry.register({
    definition: {
      name: 'computer_use',
      description: [
        "Observe and interact with the user's current desktop through the CardBush host.",
        'Use workspace file tools for file content. Screenshots are returned as inline image artifacts.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['observe', 'screenshot', 'click', 'type', 'key', 'scroll', 'drag', 'window', 'open_app'],
          },
          x: { type: 'integer' },
          y: { type: 'integer' },
          to_x: { type: 'integer' },
          to_y: { type: 'integer' },
          width: { type: 'integer', minimum: 1 },
          height: { type: 'integer', minimum: 1 },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          clicks: { type: 'integer', minimum: 1, maximum: 5 },
          text: { type: 'string' },
          interval: { type: 'number', minimum: 0, maximum: 2 },
          key: { type: 'string' },
          keys: { type: 'array', items: { type: 'string' }, minItems: 1 },
          delta: { type: 'integer', minimum: -20, maximum: 20 },
          duration_ms: { type: 'integer', minimum: 0, maximum: 5000 },
          steps: { type: 'integer', minimum: 1, maximum: 120 },
          title_pattern: { type: 'string' },
          hwnd: { type: 'integer' },
          operation: {
            type: 'string',
            enum: ['activate', 'focus', 'minimize', 'maximize', 'restore', 'close', 'move', 'resize'],
          },
          app: { type: 'string' },
          refresh: { type: 'boolean' },
        },
      },
    },
    manifest: manifest('desktop.control', 'desktop_control', true),
    decodeInput: computerInput,
    authorize: authorizeComputerUse,
    execute: (context) => executeHostTool(context, invoke),
    parallelSafe: false,
    visibleToChild: true,
    registrationOwner: 'cardbush_product_host',
  });
  registry.register({
    definition: {
      name: 'transport_deliver',
      description: 'Deliver existing files to the current Bot conversation through its active CardBush transport.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['deliverables'],
        properties: {
          deliverables: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path'],
              properties: { path: { type: 'string', minLength: 1 } },
            },
          },
          channel: { type: 'string', enum: ['weixin', 'feishu', 'telegram', 'discord'] },
          text: { type: 'string' },
        },
      },
    },
    manifest: manifest('transport.deliver', 'external_delivery', true),
    decodeInput: deliveryInput,
    authorize: authorizeDelivery,
    execute: (context) => executeDelivery(context, invoke),
    parallelSafe: false,
    visibleToChild: true,
    registrationOwner: 'cardbush_product_host',
  });
}

function computerInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('computer_use input must be an object.');
  }
  const input = value as Record<string, unknown>;
  const action = String(input.action ?? '').trim();
  if (!computerActions.has(action)) throw new Error(`Unsupported computer_use action: ${action}`);
  return structuredClone(input);
}

const computerActions = new Set([
  'observe', 'screenshot', 'click', 'type', 'key', 'scroll', 'drag', 'window', 'open_app',
]);

interface DeliveryInput {
  deliverables: Array<{ path: string }>;
  channel?: string;
  text?: string;
}

function deliveryInput(value: unknown): DeliveryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('transport_deliver input must be an object.');
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.deliverables) || input.deliverables.length < 1 || input.deliverables.length > 6) {
    throw new Error('deliverables must contain between 1 and 6 files.');
  }
  const deliverables = input.deliverables.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('deliverable must be an object.');
    const path = String((item as Record<string, unknown>).path ?? '').trim();
    if (!path) throw new Error('deliverable path is required.');
    return { path };
  });
  const channel = String(input.channel ?? '').trim();
  if (channel && !['weixin', 'feishu', 'telegram', 'discord'].includes(channel)) {
    throw new Error(`Unsupported transport channel: ${channel}`);
  }
  return {
    deliverables,
    ...(channel ? { channel } : {}),
    ...(typeof input.text === 'string' && input.text.trim() ? { text: input.text.trim() } : {}),
  };
}

async function authorizeDelivery(context: ToolAdmissionContext<DeliveryInput>) {
  const paths = await deliveryPaths(context);
  if (String(context.turn?.request.metadata.permissionMode ?? '') === 'all_free') {
    return { kind: 'allow' as const };
  }
  const root = workspaceRoot(context);
  const outside = root ? paths.filter((path) => !pathIsWithin(root, path)) : paths;
  const capabilityIds = paths.map((path) => `transport:read:${path.toLowerCase()}`);
  return {
    kind: 'ask' as const,
    request: {
      reason: outside.length
        ? 'File delivery requires reading files outside the active workspace.'
        : 'The Agent requested delivery of files to an external conversation.',
      actions: ['transport.deliver'],
      resources: paths,
      capabilityIds,
    },
  };
}

async function executeDelivery(
  context: ToolHandlerContext<DeliveryInput>,
  invoke: (request: ProductHostToolRequest) => Promise<ProductHostToolResponse>,
): Promise<ToolResult> {
  const paths = await deliveryPaths(context);
  const response = await invoke({
    toolName: context.toolCall.name,
    input: {
      sessionId: context.sessionId,
      paths,
      channel: context.input.channel,
      text: context.input.text,
    },
    context: {
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      capabilityIds: context.capabilityIds,
    },
    signal: context.signal,
  });
  return hostResponseResult(context, response);
}

async function deliveryPaths(context: ToolAdmissionContext<DeliveryInput>): Promise<string[]> {
  const root = workspaceRoot(context);
  const paths: string[] = [];
  for (const deliverable of context.input.deliverables) {
    const candidate = isAbsolute(deliverable.path)
      ? resolve(deliverable.path)
      : root
        ? resolve(root, deliverable.path)
        : resolve(deliverable.path);
    const canonical = await realpath(candidate);
    if (!(await stat(canonical)).isFile()) throw new Error(`Deliverable is not a file: ${canonical}`);
    paths.push(canonical);
  }
  return [...new Set(paths)];
}

function workspaceRoot(context: ToolAdmissionContext<unknown>): string | undefined {
  const value = String(context.turn?.request.metadata.projectDir ?? '').trim();
  return value ? resolve(value) : undefined;
}

function pathIsWithin(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function authorizeComputerUse(context: ToolAdmissionContext<Record<string, unknown>>) {
  const action = String(context.input.action);
  if (action === 'observe' || action === 'screenshot') return { kind: 'allow' as const };
  if (String(context.turn?.request.metadata.permissionMode ?? '') === 'all_free') {
    return { kind: 'allow' as const };
  }
  const resource = computerResource(context.input);
  const capabilityId = `desktop:${action}:${resource}`;
  return {
    kind: 'ask' as const,
    request: {
      reason: `The Agent requested a desktop ${action} action.`,
      actions: [`desktop.${action}`],
      resources: [resource],
      capabilityIds: [capabilityId],
    },
  };
}

function computerResource(input: Record<string, unknown>): string {
  if (input.action === 'window') {
    return `window://${String(input.hwnd ?? input.title_pattern ?? 'selected')}/${String(input.operation ?? 'activate')}`;
  }
  if (input.action === 'open_app') return `application://${String(input.app ?? 'selected')}`;
  return 'desktop://active-session';
}

async function executeHostTool(
  context: ToolHandlerContext<Record<string, unknown>>,
  invoke: (request: ProductHostToolRequest) => Promise<ProductHostToolResponse>,
): Promise<ToolResult> {
  const response = await invoke({
    toolName: context.toolCall.name,
    input: context.input,
    context: {
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      capabilityIds: context.capabilityIds,
    },
    signal: context.signal,
  });
  return hostResponseResult(context, response);
}

function hostResponseResult(
  context: ToolHandlerContext<unknown>,
  response: ProductHostToolResponse,
): ToolResult {
  const receiptId = `receipt_${crypto.randomUUID()}`;
  return {
    protocol: BUSH_TOOL_RESULT_PROTOCOL,
    tool_call_id: context.toolCall.id,
    success: response.success,
    output: response.output,
    facts: [{
      protocol: BUSH_EXECUTION_FACT_PROTOCOL,
      receipt_id: receiptId,
      action_manifest_id: context.actionManifest.manifest_id,
      status: response.success ? 'succeeded' : 'failed',
      operation: context.actionManifest.operation,
      effect_kind: context.actionManifest.effect_kind,
      owner: context.actionManifest.owner,
      dispatch_scope: context.actionManifest.dispatch_scope,
      categories: [context.actionManifest.effect_kind],
      paths: response.paths ?? [],
      execution_success: response.success,
      semantic_success: response.success,
      verification_state: response.success ? 'verified' : 'failed',
      error_code: response.error?.code ?? '',
    }],
    artifacts: response.artifacts ?? [],
    workspace_changes: [],
    guidance: [],
    ...(response.error ? { error: response.error } : {}),
  };
}

function manifest(operation: string, effectKind: string, mutating: boolean) {
  return {
    effect_kind: effectKind,
    operation,
    risk: mutating ? 'medium' : 'low',
    owner: 'cardbush_product_host',
    dispatch_phase: 'execution',
    dispatch_scope: 'process',
    dispatch_side_effect: mutating ? effectKind : 'none',
    dispatch_mutating: mutating,
    dispatch_source: 'registered_tool',
    stage_modes: ['execute'],
    output_kinds: ['structured_data', 'artifact'],
    handoff_exports: ['artifact'],
    evidence_hints: ['desktop_state', 'screenshot'],
  };
}

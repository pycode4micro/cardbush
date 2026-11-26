import { agentV1PermissionMode, permissionModeSchema } from '@cardbush/bush-protocol';
import type { AgentOperation } from './agentTypes.js';

type Fields = Record<string, unknown>;
type ModeProjection = (value: unknown) => unknown;
function fields(value: unknown): Fields | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
}
function withMode(value: unknown, key: 'permissionMode' | 'childPermissionMode' | 'mode', project: ModeProjection): unknown {
  const row = fields(value);
  if (!row || !Object.hasOwn(row, key)) return value;
  const mode = project(row[key]);
  return mode === row[key] ? value : { ...row, [key]: mode };
}
function withScope(value: unknown, project: ModeProjection) {
  const row = fields(value);
  return row?.scope ? { ...row, scope: withMode(row.scope, 'mode', project) } : value;
}

const decodeMode: ModeProjection = value => permissionModeSchema.safeParse(value).data ?? value;

/** Agent v1 uses the original values. Map only transport-owned fields. */
export function encodeAgentPermissionInput(operation: AgentOperation, input: Fields): Fields {
  if (operation === 'chat.send' || operation === 'delegation.submit') return withMode(input, 'permissionMode', agentV1PermissionMode) as Fields;
  if (operation === 'webhooks.command' && input.settings) return { ...input, settings: withMode(input.settings, 'permissionMode', agentV1PermissionMode) };
  if (operation === 'runtime.command' && input.kind === 'runtime.assistant_conversation') {
    const payload = fields(input.payload);
    if (payload?.parent) return { ...input, payload: { ...payload, parent: withMode(payload.parent, 'permissionMode', agentV1PermissionMode) } };
  }
  return input;
}

function projectAgentPermissionEvent(event: unknown, project: ModeProjection) {
  const row = fields(event);
  return row?.kind === 'permission_requested' ? { ...row, payload: withScope(row.payload, project) } : event;
}
export const encodeAgentPermissionEvent = (event: unknown) => projectAgentPermissionEvent(event, agentV1PermissionMode);
export const decodeAgentPermissionEvent = (event: unknown) => projectAgentPermissionEvent(event, decodeMode);

function withCards(row: Fields, project: ModeProjection) {
  if (!Array.isArray(row.permissions)) return row;
  return { ...row, permissions: row.permissions.map(value => {
    const card = fields(value);
    return card ? { ...card, request: withScope(card.request, project) } : value;
  }) };
}

function projectReply(operation: AgentOperation, input: Fields, result: unknown, project: ModeProjection): unknown {
  if (operation === 'chat.jobs' && Array.isArray(result)) return result.map(job => withMode(job, 'permissionMode', project));
  if (operation === 'delegation.submit') return withMode(result, 'permissionMode', project);
  if (operation === 'product.command' && input.kind === 'subagents.get') return withMode(result, 'childPermissionMode', project);
  if (operation === 'runtime.command' && input.kind === 'runtime.list_turn_events' && Array.isArray(result)) {
    return result.map(event => projectAgentPermissionEvent(event, project));
  }
  const row = fields(result);
  if (operation === 'chat.events' && row && Array.isArray(row.events)) {
    return { ...row, events: row.events.map(event => projectAgentPermissionEvent(event, project)) };
  }
  if (operation === 'chat.send' || operation === 'chat.queue') {
    return row && Array.isArray(row.jobs) ? { ...row, jobs: row.jobs.map(job => withMode(job, 'permissionMode', project)) }
      : withMode(result, 'permissionMode', project);
  }
  if (operation === 'runtime.command' && input.kind === 'runtime.assistant_conversation' && row) {
    const management = fields(row.management);
    if (management) return { ...row, management: withCards(management, project) };
  }
  if (operation === 'runtime.command' && input.kind === 'runtime.friends' && row) return withCards(row, project);
  return result;
}
export const encodeAgentPermissionReply = (operation: AgentOperation, input: Fields, result: unknown) => projectReply(operation, input, result, agentV1PermissionMode);
export const decodeAgentPermissionReply = (operation: AgentOperation, input: Fields, result: unknown) => projectReply(operation, input, result, decodeMode);

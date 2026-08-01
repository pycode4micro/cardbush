import type { TaskPlanSnapshot, TaskPlanStreamUpdate, TaskPlanStatus } from '../types';

export const taskPlanProtocol = 'bush.task_plan.v1';

const planKeys = new Set([
  'protocol',
  'plan_id',
  'session_id',
  'nodes',
  'explanation',
  'active',
]);
const nodeKeys = new Set(['step', 'status']);
const statuses = new Set<TaskPlanStatus>(['pending', 'in_progress', 'completed']);

export function taskPlanFromPayload(
  input: unknown,
  expectedSessionId = '',
): TaskPlanSnapshot | null {
  if (!isRecord(input) || hasUnknownKeys(input, planKeys)) {
    return null;
  }
  if (input.protocol !== taskPlanProtocol || typeof input.plan_id !== 'string') {
    return null;
  }
  if (typeof input.session_id !== 'string' || !Array.isArray(input.nodes)) {
    return null;
  }
  if (typeof input.explanation !== 'string' || typeof input.active !== 'boolean') {
    return null;
  }
  const planId = boundedText(input.plan_id, 120);
  const sessionId = boundedText(input.session_id, 240);
  const expected = expectedSessionId.trim();
  if (!planId || !sessionId || (expected && sessionId !== expected)) {
    return null;
  }
  if (input.nodes.length < 1 || input.nodes.length > 20) {
    return null;
  }
  const nodes = input.nodes.map((item) => taskPlanNodeFromPayload(item));
  if (nodes.some((item) => item == null)) {
    return null;
  }
  const normalizedNodes = nodes.filter((item) => item != null);
  if (normalizedNodes.filter((item) => item.status === 'in_progress').length > 1) {
    return null;
  }
  const explanation = boundedText(input.explanation, 1200, true);
  if (explanation == null) {
    return null;
  }
  const active = normalizedNodes.some((item) => item.status !== 'completed');
  if (input.active !== active) {
    return null;
  }
  return {
    protocol: taskPlanProtocol,
    planId,
    sessionId,
    nodes: normalizedNodes,
    explanation,
    active,
  };
}

export function taskPlanUpdateFromExecutionPayload(
  input: unknown,
  expectedSessionId: string,
): TaskPlanStreamUpdate | null {
  if (!isRecord(input) || input.kind !== 'plan') {
    return null;
  }
  const turnId = typeof input.turn_id === 'string' ? input.turn_id.trim() : '';
  if (!turnId) {
    return null;
  }
  const plan = taskPlanFromPayload(input.plan, expectedSessionId);
  return plan ? { turnId, plan } : null;
}

function taskPlanNodeFromPayload(input: unknown) {
  if (!isRecord(input) || hasUnknownKeys(input, nodeKeys)) {
    return null;
  }
  if (typeof input.step !== 'string' || typeof input.status !== 'string') {
    return null;
  }
  const step = boundedText(input.step, 1200);
  const status = input.status as TaskPlanStatus;
  if (!step || !statuses.has(status)) {
    return null;
  }
  return { step, status };
}

function boundedText(value: string, limit: number, allowEmpty = false) {
  if (value.length > limit) {
    return null;
  }
  const normalized = value.trim();
  return normalized || allowEmpty ? normalized : null;
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

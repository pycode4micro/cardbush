import type { SessionMessage as RuntimeSessionMessage } from '@cardbush/bush-protocol';

const legacyInternalRuntimeMessageNames = new Set([
  'runtime_context',
  'tool_image_observation',
  'task_plan_continuation',
  'empty_stop_recovery',
  'subagent_result',
]);

const internalDeveloperMessageNames = new Set([
  'output_limit_continuation',
  'context_pressure',
  'context_compaction_correction',
]);

export function isInternalRuntimeMessage(message: Pick<RuntimeSessionMessage, 'message'>): boolean {
  if (message.message.role === 'developer' && message.message.name && internalDeveloperMessageNames.has(message.message.name)) return true;
  if (message.message.role !== 'user') return false;
  if (message.message.visibility === 'internal') return true;
  return Boolean(
    message.message.name &&
      legacyInternalRuntimeMessageNames.has(message.message.name),
  );
}

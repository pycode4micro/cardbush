import type { SessionMessage as RuntimeSessionMessage } from '@cardbush/bush-protocol';

const legacyInternalRuntimeMessageNames = new Set([
  'runtime_context',
  'tool_image_observation',
  'task_plan_continuation',
  'empty_stop_recovery',
]);

export function isInternalRuntimeMessage(message: RuntimeSessionMessage): boolean {
  if (message.message.role === 'developer' && message.message.name === 'output_limit_continuation') return true;
  if (message.message.role !== 'user') return false;
  if (message.message.visibility === 'internal') return true;
  return Boolean(
    message.message.name &&
      legacyInternalRuntimeMessageNames.has(message.message.name),
  );
}

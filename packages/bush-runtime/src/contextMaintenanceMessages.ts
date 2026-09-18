import type { ModelMessage } from '@cardbush/bush-protocol';

type ContextMaintenanceNoticeName = 'context_pressure' | 'context_compaction_correction';

/** Recognize saved maintenance messages for recovery/projection only. This
 * does not grant compaction authority; the Runtime owns that authorization.
 * Legacy internal user messages keep their original role and content. */
export function isContextMaintenanceNotice(message: ModelMessage, name?: ContextMaintenanceNoticeName): boolean {
  if (message.role !== 'developer' && (message.role !== 'user' || message.visibility !== 'internal')) return false;
  return name ? message.name === name
    : message.name === 'context_pressure' || message.name === 'context_compaction_correction';
}

export function contextCompactionCorrectionMessage(content: string): ModelMessage {
  return { role: 'developer', name: 'context_compaction_correction', content };
}

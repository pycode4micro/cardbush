import type { ChatMessage, ChatToolArtifact, ChatToolExecution } from '../src/types';
import { workSummaryOutputs } from '../src/features/chat/workSummaryOutputs';
import { personalFilePath } from './personalFiles';

const imageTools = new Set([
  'mcp__plugin_volcengine_images_images__seedream_create_task',
  'mcp__plugin_volcengine_images_images__seedream_get_task',
  'mcp__plugin_volcengine_images_images__generation_wait_tasks',
]);
export function generatedImagePath(source: string): string | null {
  const path = personalFilePath(source);
  return path?.startsWith('/data/workspaces/generated/') && /\.(png|jpe?g|webp)$/i.test(path) ? path : null;
}
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

/** Adapt only the installed image plugin's explicit receipts, never arbitrary tool prose. */
export function imageReceiptArtifacts(name: string, value: unknown): ChatToolArtifact[] {
  if (!imageTools.has(name)) return [];
  const native = record(value), result = record(native.mcp).name ? record(native.result) : native;
  const structured = record(result.structuredContent);
  const receipts = [structured.task, ...(Array.isArray(structured.items) ? structured.items.map(item => record(record(item).observation).task) : [])];
  const images = new Map<string, ChatToolArtifact>();
  for (const value of receipts) {
    const task = record(value), output = record(task.result);
    if (task.kind !== 'seedream' || task.status !== 'succeeded' || !Array.isArray(output.data)) continue;
    for (const item of output.data) {
      const source = record(item).local_path;
      const path = typeof source === 'string' ? generatedImagePath(source) : null;
      if (path) images.set(path, { id: path, path, name: path.split('/').at(-1)!, type: 'image', display: 'attachment', readOnly: true });
    }
  }
  return [...images.values()];
}

function scopedMessages(message: ChatMessage): ChatMessage {
  const belongs = (candidate: { turnId?: string; conversationId?: string }) =>
    (!message.turnId || !candidate.turnId || candidate.turnId === message.turnId) &&
    (!message.conversationId || !candidate.conversationId || candidate.conversationId === message.conversationId);
  const visit = (candidate: ChatMessage): ChatMessage => ({ ...candidate,
    loopHistory: candidate.loopHistory?.filter(belongs).map(visit),
    toolExecutions: candidate.toolExecutions?.filter(belongs),
  });
  return visit(message);
}
export function webTurnArtifacts(message: ChatMessage): ChatToolArtifact[] {
  const images = new Map<string, ChatToolArtifact>();
  for (const output of workSummaryOutputs([scopedMessages(message)], [], '/data/workspaces')) {
    const path = generatedImagePath(output.path);
    if (path && output.type === 'image') images.set(path, { id: path, path, name: output.name, type: 'image', display: 'attachment', readOnly: true });
  }
  return [...images.values()];
}
export function hasDeferredImageArtifacts(message: ChatMessage): boolean {
  const visit = (candidate: ChatMessage): boolean => (candidate.toolExecutions ?? []).some((tool: ChatToolExecution) =>
    imageTools.has(tool.name) && tool.success && tool.metadata.nativeResultDeferred === true) || Boolean(candidate.loopHistory?.some(visit));
  return visit(scopedMessages(message));
}

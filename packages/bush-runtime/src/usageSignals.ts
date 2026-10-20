import type { ToolExecutionSignal } from './toolExecutionStore.js';
import { usageRecipeIdentitySchema, type ToolExecutionRecord } from '@cardbush/bush-protocol';

const ignored = new Set(['usage', 'get_tool_schema', 'mcp_search', 'search_skills',
  'checkpoint_context', 'summary_for_user', 'update_task_plan', 'update_goal', 'read_archived_tool_result']);
const coordination = new Set(['script_completion', 'run_tools', 'tasks', 'mcp_call', 'call_tool',
  'parallel_tools', 'manage_tool_calls', 'start_mcp_tool', 'terminal_poll', 'await_subagents']);

/** One policy for teacher sampling, trigger diagnostics and student recall.
 * Dispatch failures remain evidence, but successful wrappers are not results. */
export function isUsageBusinessSignal(signal: Pick<ToolExecutionSignal, 'tool' | 'outcome' | 'usageRecipe'>) {
  return Boolean(signal.usageRecipe) || !ignored.has(signal.tool) && !(coordination.has(signal.tool) && signal.outcome === 'returned');
}

export function usageRecipeFromRecord(record: ToolExecutionRecord) {
  if (record.toolCall.name !== 'script_completion' || record.actionManifest?.owner !== 'runtime' || record.actionManifest.operation !== 'script.completion') return;
  const result = record.result && typeof record.result === 'object' ? record.result as Record<string, unknown> : undefined;
  const parsed = usageRecipeIdentitySchema.safeParse(result?.usage_recipe ?? record.error?.details?.usage_recipe);
  return parsed.success ? parsed.data : undefined;
}

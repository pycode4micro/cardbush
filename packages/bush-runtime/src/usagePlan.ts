import type { PlanState, UsageDefinition } from '@cardbush/bush-protocol';
import { usageDefinitionHash } from './usageRecipes.js';

/** Read the native plan; this module never creates or advances execution state. */
export function usagePlanView(pack: UsageDefinition, state?: PlanState, revisionAtLoad = 0) {
  const hash = usageDefinitionHash(pack);
  const template = pack.plan.map(id => ({
    step: pack.nodes.find(node => node.id === id)!.name,
    status: 'pending' as const,
    usage: { usage_id: pack.id, node_id: id, definition_sha256: hash },
  }));
  const matches = (node: PlanState['plan']['nodes'][number]) =>
    node.usage?.usage_id === pack.id && node.usage.definition_sha256 === hash &&
    pack.nodes.some(lesson => lesson.id === node.usage!.node_id);
  const previousCompletedTask = state?.revision === revisionAtLoad && !state.plan.active;
  const bound = previousCompletedTask ? [] : state?.plan.nodes.filter(matches) ?? [];
  // An unrelated active step must not be presented as one of the manual's nodes.
  const current = state?.plan.nodes.find(node => node.status === 'in_progress')
    ?? state?.plan.nodes.find(node => node.status === 'waiting')
    ?? state?.plan.nodes.find(node => node.status === 'pending');
  let phase: 'legacy' | 'unbound' | 'active' | 'adapted' | 'completed' = 'legacy';
  if (template.length) {
    if (bound.length) phase = current && matches(current) ? 'active' : current ? 'adapted' : 'completed';
    else if (state && state.revision > revisionAtLoad) phase = state.plan.active ? 'adapted' : 'completed';
    else phase = 'unbound';
  }
  return {
    phase,
    current_node: phase === 'active' ? current!.usage!.node_id : null,
    native_plan: state ? {
      plan_id: state.plan.plan_id, revision: state.revision, active: state.plan.active,
      nodes: state.plan.nodes.map(node => ({ id: node.id, step: node.step.slice(0, 240), status: node.status,
        ...(node.waitingFor ? { waitingFor: node.waitingFor.slice(0, 240) } : {}),
        ...(node.usage ? { usage: node.usage, matches_manual: matches(node) } : {}) })),
    } : null,
    // Once linked, the plan itself contains the bindings. Avoid sending two plans.
    ...(phase === 'unbound' ? { plan_template: {
      tool: 'update_task_plan', input: { action: 'replace', nodes: template },
      note: 'Reuse or adapt these nodes with update_task_plan. Read any existing plan first and preserve unrelated work. Keep usage references when renaming/reordering; remove a reference when deliberately replacing its method. If a cached tool schema lacks usage, load get_tool_schema(name="update_task_plan") and use the existing call_tool dispatcher. These are suggestions, not executed steps.',
    } } : {}),
  };
}

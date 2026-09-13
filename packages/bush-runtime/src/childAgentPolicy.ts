import { DEFAULT_CHILD_AGENT_DISABLED_TOOLS, type ModelRequest } from '@cardbush/bush-protocol';
import type { ToolRegistration } from './toolRegistry.js';

export const CHILD_AGENT_ASSIGNMENT_PREFIX = '你当前处于子agent状态';

export function childAgentDispatchDenial(request?: Pick<ModelRequest, 'metadata'>) {
  if (request?.metadata.agentRole !== 'child') return undefined;
  return {
    code: 'child_agent_dispatch_unavailable',
    message: 'You are currently a child Agent. Subagent dispatch is unavailable in child state. Complete your assigned work and report results or dependencies to the parent Agent instead of delegating again.',
  };
}

export function assertParentAgent(request?: Pick<ModelRequest, 'metadata'>): void {
  const denial = childAgentDispatchDenial(request);
  if (denial) throw Object.assign(new Error(denial.message), { code: denial.code });
}

/** Child restrictions affect admission, never the cached tool declarations. */
export function childAgentToolDenial(request: ModelRequest | undefined, registration: ToolRegistration) {
  if (request?.metadata.agentRole !== 'child') return undefined;
  const name = registration.definition.name;
  if (name === 'subagent' || name === 'team_delegate' || name === 'await_subagents') {
    return childAgentDispatchDenial(request);
  }
  const disabled: readonly unknown[] = Array.isArray(request.metadata.disabledTools)
    ? request.metadata.disabledTools : DEFAULT_CHILD_AGENT_DISABLED_TOOLS;
  const allowlist = request.metadata.childToolAllowlist;
  if (registration.visibleToChild === false || disabled.includes(name) ||
    (Array.isArray(allowlist) && !allowlist.includes(name))) {
    return {
      code: 'child_agent_tool_unavailable',
      message: `You are currently a child Agent. Tool ${name} is unavailable under this child task's policy. Continue with the permitted tools and report any remaining dependency to the parent Agent.`,
    };
  }
  // Shadow keeps the same declarations in both modes. Enforce its former
  // catalog restrictions here, before hooks, authorization or tool side effects.
  if (name !== 'checkpoint_context') {
    if ((request.metadata.shadowReadOnly === true || request.metadata.shadowMode === 'readonly') &&
      registration.manifest.mutating !== false) {
      return {
        code: 'shadow_read_only',
        message: `You are currently a child Agent in read-only Shadow mode. Tool ${name} can modify resources and cannot execute in this mode. Analyze with read-only tools; the user can switch this Shadow to Fork to make changes.`,
      };
    }
    const workspace = request.metadata.shadowWorkspaceDir ?? request.metadata.projectDir;
    if (request.metadata.shadowMode === 'fork' && registration.manifest.dispatch_scope === 'resource' &&
      !(typeof workspace === 'string' && workspace.trim())) {
      return {
        code: 'shadow_workspace_required',
        message: `You are currently a child Agent in Shadow Fork mode without an attached workspace. Tool ${name} requires a workspace and cannot execute here. Explain the missing workspace to the user.`,
      };
    }
  }
  return undefined;
}

import { AlertCircle, ShieldCheck } from 'lucide-react';

import type { ChatToolExecution } from '../types';

export type ToolHookDecision = {
  tone: 'blocked' | 'notice';
  title: string;
  detail: string;
};

export function ToolHookDecisionNotice({
  decision,
}: {
  decision: ToolHookDecision;
}) {
  return (
    <div className={`tool-hook-decision ${decision.tone}`}>
      {decision.tone === 'blocked' ? (
        <AlertCircle size={14} />
      ) : (
        <ShieldCheck size={14} />
      )}
      <span>
        <strong>{decision.title}</strong>
        <small>{decision.detail}</small>
      </span>
    </div>
  );
}

export function toolHookDecisionFromExecution(
  execution: ChatToolExecution,
): ToolHookDecision | null {
  const metadata = execution.metadata;
  const hook = String(metadata.hook ?? metadata.agent_hook ?? '').trim();
  const hookPhase = String(metadata.hook_phase ?? metadata.hookPhase ?? '').trim();
  const hookAction = String(metadata.hook_action ?? metadata.hookAction ?? '').trim();
  const requestedTool = String(
    metadata.requested_tool ?? metadata.requestedTool ?? metadata.tool_name ?? '',
  ).trim();
  const policy = String(metadata.policy ?? metadata.hook_policy ?? '').trim();
  const path = String(metadata.path ?? metadata.file_path ?? metadata.filePath ?? '').trim();
  if (!hook && !hookPhase && !hookAction && execution.name !== 'assistant.tool_call_validation') {
    return null;
  }
  const blocked = /block|deny|reject|retry|interrupt/i.test(hookAction);
  const titleParts = [
    hook || 'hook',
    hookAction ? hookAction.replace(/_/g, ' ') : '',
  ].filter(Boolean);
  const detailParts = [
    hookPhase,
    requestedTool ? `tool: ${requestedTool}` : '',
    policy ? `policy: ${policy}` : '',
    path ? compactPath(path) : '',
  ].filter(Boolean);
  return {
    tone: blocked ? 'blocked' : 'notice',
    title: titleParts.join(' · '),
    detail: detailParts.join(' · ') || execution.summary || execution.output,
  };
}

function compactPath(value?: string) {
  if (!value) {
    return '~';
  }
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.length <= 2) {
    return value;
  }
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

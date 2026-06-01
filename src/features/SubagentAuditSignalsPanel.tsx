import { Network } from 'lucide-react';

import type { AppLanguage, ChatToolExecution } from '../types';
import {
  asRecord,
  firstRecord,
  nonEmptyString,
  optionalBoolean,
  parseToolOutputJson,
  stringArrayLoose,
  summarizeLooseValue,
  summarizeWriteScope,
} from './toolPayload';

export type SubagentAuditSignals = {
  taskHealth: string;
  lastEffectiveAction: string;
  changedFiles: string[];
  verificationObserved: string;
  shouldParentIntervene?: boolean;
  nextParentAction: string;
};

export function SubagentAuditSignalsPanel({
  signals,
  language,
}: {
  signals: SubagentAuditSignals;
  language: AppLanguage;
}) {
  const rows = [
    [language === 'zh' ? '有效动作' : 'Last action', signals.lastEffectiveAction],
    [
      language === 'zh' ? '验证观察' : 'Verification',
      signals.verificationObserved,
    ],
    [
      language === 'zh' ? '需父级介入' : 'Parent intervene',
      signals.shouldParentIntervene == null
        ? ''
        : signals.shouldParentIntervene
          ? language === 'zh'
            ? '是'
            : 'Yes'
          : language === 'zh'
            ? '否'
            : 'No',
    ],
    [language === 'zh' ? '下一步' : 'Next action', signals.nextParentAction],
    [
      language === 'zh' ? '变更文件' : 'Changed files',
      signals.changedFiles.length > 0 ? summarizeWriteScope(signals.changedFiles) : '',
    ],
  ].filter(([, value]) => value);
  return (
    <section
      className={`subagent-audit-signals ${
        signals.shouldParentIntervene ? 'intervene' : ''
      }`}
    >
      <header>
        <Network size={14} />
        <strong>{language === 'zh' ? '子 Agent 状态' : 'Subagent status'}</strong>
        {signals.taskHealth && <em>{signals.taskHealth}</em>}
      </header>
      {rows.length > 0 && (
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function subagentAuditSignalsFromExecution(
  execution: ChatToolExecution,
): SubagentAuditSignals | null {
  const outputPayload = parseToolOutputJson(execution.output);
  const raw = firstRecord([
    asRecord(execution.metadata.audit_signals),
    asRecord(execution.metadata.auditSignals),
    asRecord(asRecord(execution.metadata.result).audit_signals),
    asRecord(asRecord(execution.metadata.result).auditSignals),
    asRecord(outputPayload.audit_signals),
    asRecord(outputPayload.auditSignals),
    asRecord(asRecord(outputPayload.result).audit_signals),
    asRecord(asRecord(outputPayload.result).auditSignals),
  ]);
  if (Object.keys(raw).length === 0) {
    return null;
  }
  const taskHealth = nonEmptyString(raw.task_health ?? raw.taskHealth) ?? '';
  const lastEffectiveAction =
    nonEmptyString(raw.last_effective_action ?? raw.lastEffectiveAction) ?? '';
  const changedFiles = stringArrayLoose(raw.changed_files ?? raw.changedFiles);
  const verificationObserved =
    summarizeLooseValue(raw.verification_observed ?? raw.verificationObserved);
  const shouldParentIntervene = optionalBoolean(
    raw.should_parent_intervene ?? raw.shouldParentIntervene,
  );
  const nextParentAction =
    nonEmptyString(raw.next_parent_action ?? raw.nextParentAction) ?? '';
  if (
    !taskHealth &&
    !lastEffectiveAction &&
    changedFiles.length === 0 &&
    !verificationObserved &&
    shouldParentIntervene == null &&
    !nextParentAction
  ) {
    return null;
  }
  return {
    taskHealth,
    lastEffectiveAction,
    changedFiles,
    verificationObserved,
    shouldParentIntervene,
    nextParentAction,
  };
}

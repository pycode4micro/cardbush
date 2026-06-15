import { Clipboard } from 'lucide-react';

import type { AppLanguage, ChatToolExecution } from '../../types';
import {
  asRecord,
  firstRecord,
  looseBoolean,
  nonEmptyString,
  parseToolOutputJson,
} from './toolPayload';

export type PlanningAssessmentInfo = {
  mode: string;
  planExpected: boolean;
  planSaved: boolean;
};

export function PlanningAssessmentNotice({ language }: { language: AppLanguage }) {
  return (
    <div className="tool-planning-assessment">
      <Clipboard size={13} />
      <span>{language === 'zh' ? '已生成计划书' : 'Reference plan saved'}</span>
    </div>
  );
}

export function planningAssessmentFromExecution(
  execution: ChatToolExecution,
): PlanningAssessmentInfo | null {
  const outputPayload = parseToolOutputJson(execution.output);
  const payloads = [
    execution.metadata,
    asRecord(execution.metadata.result),
    asRecord(execution.metadata.payload),
    outputPayload,
    asRecord(outputPayload.result),
  ];
  const assessment = firstRecord(
    payloads.flatMap((payload) => [
      asRecord(payload.planning_assessment),
      asRecord(payload.planningAssessment),
    ]),
  );
  const mode = nonEmptyString(assessment.mode) ?? '';
  const planExpected =
    looseBoolean(assessment.plan_expected ?? assessment.planExpected) ?? false;
  const planSaved =
    looseBoolean(assessment.plan_saved ?? assessment.planSaved) ?? false;
  if (mode !== 'reference_plan' || !planSaved) {
    return null;
  }
  return { mode, planExpected, planSaved };
}

import { Puzzle } from 'lucide-react';

import type { AppLanguage, ChatToolExecution } from '../../types';
import { displayToolName } from './toolExecutionState';
import {
  asRecord,
  nonEmptyString,
  parseToolOutputJson,
} from './toolPayload';

export type ToolActionEnvelope = {
  service: string;
  action: string;
  routedTool: string;
  readTool: string;
  readAction: string;
  readLocator: string;
  result?: unknown;
};

export function ToolActionEnvelopeInfo({
  envelope,
  language,
}: {
  envelope: ToolActionEnvelope;
  language: AppLanguage;
}) {
  const items = [
    envelope.service ? envelope.service.toUpperCase() : '',
    envelope.action ? `action: ${envelope.action}` : '',
    envelope.routedTool ? `route: ${displayToolName(envelope.routedTool)}` : '',
    envelope.readTool ? `read: ${displayToolName(envelope.readTool)}` : '',
    envelope.readAction === 'read_temp' && envelope.readLocator
      ? `read_temp: ${envelope.readLocator}`
      : '',
  ].filter(Boolean);
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="tool-action-envelope">
      <Puzzle size={13} />
      <span>{language === 'zh' ? '聚合工具' : 'Action tool'}</span>
      {items.map((item) => (
        <code key={item}>{item}</code>
      ))}
    </div>
  );
}

export function toolActionEnvelopeFromExecution(
  execution: ChatToolExecution,
): ToolActionEnvelope | null {
  const outputPayload = parseToolOutputJson(execution.output);
  const metadata = execution.metadata;
  const resultPayload = asRecord(metadata.result);
  const candidates = [
    outputPayload,
    metadata,
    resultPayload,
    asRecord(outputPayload.result),
    asRecord(resultPayload.result),
  ];
  const service = nonEmptyString(
    candidates.find((candidate) => nonEmptyString(candidate.service))?.service,
  );
  const executionName = execution.name.trim().toLowerCase();
  if (!service && executionName !== 'ked' && executionName !== 'lem') {
    return null;
  }
  const serviceName = service || executionName;
  if (serviceName !== 'ked' && serviceName !== 'lem') {
    return null;
  }
  const candidateWithResult =
    candidates.find((candidate) => Object.prototype.hasOwnProperty.call(candidate, 'result')) ??
    {};
  const candidateWithReadArgs = candidates.find(
    (candidate) =>
      Object.keys(asRecord(candidate.read_args ?? candidate.readArgs)).length > 0,
  );
  const readArgs = asRecord(
    candidateWithReadArgs?.read_args ?? candidateWithReadArgs?.readArgs,
  );
  return {
    service: serviceName,
    action:
      nonEmptyString(
        candidates.find((candidate) => nonEmptyString(candidate.action))?.action,
      ) ?? '',
    routedTool:
      nonEmptyString(
        candidates.find((candidate) =>
          nonEmptyString(candidate.routed_tool ?? candidate.routedTool),
        )?.routed_tool ??
          candidates.find((candidate) =>
            nonEmptyString(candidate.routed_tool ?? candidate.routedTool),
          )?.routedTool,
      ) ?? '',
    readTool: nonEmptyString(readArgs.read_tool ?? readArgs.readTool) ?? '',
    readAction: nonEmptyString(readArgs.action) ?? '',
    readLocator: nonEmptyString(readArgs.locator) ?? '',
    result: candidateWithResult.result,
  };
}

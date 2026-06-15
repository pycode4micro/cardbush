import type { ChatToolExecution } from '../../types';
import { textLength, truncateText } from '../../shared/text';

type ToolOutputEnvelope = {
  result?: unknown;
};

export function toolOutputNeedsCollapse(output: string) {
  if (!output.trim()) {
    return false;
  }
  return textLength(output) > 320 || output.split(/\r?\n/).length > 4;
}

export function compactToolOutput(output: string) {
  const lines = output.split(/\r?\n/);
  const preview = lines.slice(0, 3).join('\n');
  if (textLength(preview) <= 320) {
    return preview;
  }
  return truncateText(preview, 320).trimEnd();
}

export function toolDisplayOutput(
  execution: ChatToolExecution,
  envelope: ToolOutputEnvelope | null,
) {
  if (!envelope || envelope.result == null || envelope.result === '') {
    return execution.output;
  }
  if (typeof envelope.result === 'string') {
    return envelope.result;
  }
  try {
    return JSON.stringify(envelope.result, null, 2);
  } catch {
    return String(envelope.result);
  }
}

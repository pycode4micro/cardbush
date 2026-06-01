import { Cpu, Network } from 'lucide-react';

import type { ChatToolExecution } from '../types';
import { asRecord } from './toolPayload';

export function RuntimeProfileBadge({ info }: { info: string }) {
  if (!info) {
    return null;
  }
  return (
    <div className="tool-runtime-profile">
      <Cpu size={13} />
      <span>{info}</span>
    </div>
  );
}

export function WorkerProfileBadge({ info }: { info: string }) {
  if (!info) {
    return null;
  }
  return (
    <div className="tool-worker-profile">
      <Network size={13} />
      <span>{info}</span>
    </div>
  );
}

export function runtimeProfileInfoFromExecution(execution: ChatToolExecution) {
  if (execution.name !== 'choose_execution_flow') {
    return '';
  }
  const metadata = execution.metadata;
  const protocol = asRecord(
    metadata.execution_protocol ??
      metadata.executionProtocol ??
      asRecord(metadata.result).execution_protocol ??
      asRecord(metadata.result).executionProtocol,
  );
  const profileValue = String(
    protocol.agent_profile ??
      protocol.runtime_profile ??
      metadata.agent_runtime_profile ??
      metadata.agentProfile ??
      '',
  ).trim();
  const laneValue = String(protocol.profile_lane ?? protocol.lane ?? '').trim();
  const hookValue = String(protocol.profile_hooks ?? protocol.profile_hook_set ?? '').trim();
  const segments = [
    profileValue ? `profile: ${profileValue}` : '',
    laneValue ? `lane: ${laneValue}` : '',
    hookValue ? `hooks: ${hookValue}` : '',
  ].filter(Boolean);
  return segments.join(' · ');
}

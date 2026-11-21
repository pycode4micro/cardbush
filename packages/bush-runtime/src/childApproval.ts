import { remoteInteractionSchema, runtimePermissionAnswerSchema, type RemoteResponse } from '@cardbush/bush-protocol';

const silentApprovals = new WeakMap<object, string>();

/** Record only a broker-confirmed decision on this exact parent-owned request. */
export function childApprovalReceipt(result: unknown, response: RemoteResponse, report: boolean): unknown {
  if (report || response.kind !== 'permission') return result;
  const receipt = runtimePermissionAnswerSchema.safeParse(result);
  if (receipt.success && receipt.data.permissionId === response.interactionId && receipt.data.decision === response.decision) {
    const annotated = { ...(result as object) };
    silentApprovals.set(annotated, response.interactionId);
    return annotated;
  }
  return result;
}

export function silentChildApproval(result: unknown): string | undefined {
  return result && typeof result === 'object' ? silentApprovals.get(result) : undefined;
}

export function transferChildApproval(source: unknown, snapshot: unknown) {
  const id = silentChildApproval(source);
  if (id !== undefined && snapshot && typeof snapshot === 'object') silentApprovals.set(snapshot, id);
}

export function childApprovalNoticeId(content: string): string | undefined {
  try {
    const interaction = remoteInteractionSchema.parse(JSON.parse(content.slice(content.lastIndexOf('\n') + 1)));
    if (interaction.kind === 'permission' && interaction.authority === 'parent_delegate') return interaction.interactionId;
  } catch { /* An invalid or historical notice cannot end a turn. */ }
  return undefined;
}

export function finishedChildApprovals(notices: readonly (string | undefined)[], approvals: ReadonlySet<string>) {
  return notices.length > 0 && notices.every(id => id !== undefined && approvals.has(id));
}

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { McpAttachmentReader, McpFileOperation, RuntimePermissionTarget } from '@cardbush/bush-protocol';
import { isParentApprovedChild, pathAdmission, resolveToolPath, type ToolAdmissionContext } from '@cardbush/bush-runtime';

export async function fileOperationPermission(context: ToolAdmissionContext<Record<string, unknown>>, resource: string, operation?: McpFileOperation,
  reader?: McpAttachmentReader & { implementationFingerprint: string }) {
  const input = { ...context.input };
  const targets: RuntimePermissionTarget[] = [{ kind: 'mcp_resource', value: resource }];
  const actions = ['external_tool_call'];
  let outsideScope = false;
  let outsideParentScope = false;
  const hostCode = operation?.execution === 'host_code';
  const parentApproval = isParentApprovedChild(context) && hostCode;
  // File arguments do not constrain host code. A parent can approve it only
  // with full authority granted by the host, regardless of the file format.
  let requiresHuman = parentApproval && context.parentWorkspaceAuthority?.permissionMode !== 'all_free';
  const file = async (value: unknown, action: 'read' | 'write') => {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Use absolute paths for this file operation.');
    const path = await resolveToolPath(context, value, action === 'write');
    const admission = await pathAdmission(context, path, action);
    if (admission.kind === 'ask') {
      outsideScope = true;
      outsideParentScope ||= admission.request.outsideParentScope === true;
      requiresHuman ||= admission.request.requiresHuman === true;
    }
    targets.push({ kind: 'filesystem_path', value: path, label: `${action === 'read' ? 'Read' : 'Write'}: ${path}` });
    if (!actions.includes(action)) actions.push(action);
    return path;
  };
  const paths = operation?.paths ?? (reader ? [{ argument: reader.pathArgument, kind: 'path', access: 'read' } as const] : []);
  for (const spec of paths) {
    const value = input[spec.argument];
    if (spec.kind === 'path') { input[spec.argument] = await file(value, spec.access); continue; }
    const entries = value === undefined && spec.access === 'read' ? [] : value;
    if (!Array.isArray(entries) || spec.access === 'write' && !entries.length) throw new Error('Specify the file paths for this operation.');
    const resolved = [];
    for (const entry of entries) {
      if (spec.kind === 'paths') resolved.push(await file(entry, spec.access));
      else {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Expected an object containing a file path.');
        resolved.push({ ...entry, [spec.property]: await file(entry[spec.property], spec.access) });
      }
    }
    input[spec.argument] = resolved;
  }
  let reason = hostCode ? 'Run code with host access using the listed files.' : 'Allow this external operation on the listed files.';
  let identity: unknown[] = [resource, input];
  let reuseApprovalForTurn = false;
  const path = reader && input[reader.pathArgument];
  if (reader && !hostCode && paths.length === 1 && paths[0]?.kind === 'path' && paths[0].access === 'read' &&
      paths[0].argument === reader.pathArgument && typeof path === 'string' && context.isTurnAttachment?.(path) &&
      Object.keys(input).every(key => key === reader.pathArgument || reader.readArguments.includes(key))) {
    const version = await stat(path, { bigint: true });
    if (version.isFile()) {
      reuseApprovalForTurn = true;
      reason = 'Read this attachment, including additional pages or worksheets, for the current task.';
      identity = [resource, reader.implementationFingerprint, reader.pathArgument, [...new Set(reader.readArguments)].sort(), path, 'task_read',
        [version.dev, version.ino, version.size, version.mtimeNs, version.ctimeNs].map(String)];
    }
  }
  const capabilityId = 'capability:mcp:document:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return { input, capabilityId, outsideScope, parentApproval, request: { reason, targets, actions, capabilityIds: [capabilityId], requiresHuman,
    ...(outsideParentScope ? { outsideParentScope } : {}),
    ...(reuseApprovalForTurn ? { reuseApprovalForTurn } : {}) } };
}

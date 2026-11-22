import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { McpServerSnapshot, RuntimePermissionTarget } from '@cardbush/bush-protocol';
import { isParentApprovedChild, pathAdmission, resolveToolPath, type ToolAdmissionContext } from '@cardbush/bush-runtime';

const documentPlugins = new Set(['pdf', 'docx', 'pptx', 'xlsx']);
const documentTools = new Set(['inspect_document', 'author_document', 'convert_document', 'render_pdf_page', 'render_presentation']);

export function isDocumentFileTool(server: McpServerSnapshot, tool: string): boolean {
  return server.transport.kind === 'stdio' && documentPlugins.has(server.pluginId ?? '') &&
    server.id === `plugin_${server.pluginId}_documents` && documentTools.has(tool);
}

export async function documentFilePermission(context: ToolAdmissionContext<Record<string, unknown>>, resource: string, tool: string) {
  const input = { ...context.input };
  const targets: RuntimePermissionTarget[] = [{ kind: 'mcp_resource', value: resource }];
  const actions = ['external_tool_call'];
  let outsideScope = false;
  let externalWrite = false;
  const file = async (value: unknown, action: 'read' | 'write') => {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Use an absolute document file path.');
    const path = await resolveToolPath(context, value, action === 'write');
    const admission = await pathAdmission(context, path, action);
    if (admission.kind === 'ask') {
      outsideScope = true;
      if (action === 'write') externalWrite = true;
    }
    targets.push({ kind: 'filesystem_path', value: path, label: `${action === 'read' ? 'Read' : 'Write'}: ${path}` });
    if (!actions.includes(action)) actions.push(action);
    return path;
  };
  if (tool === 'author_document') {
    const inputs = [];
    if (Array.isArray(input.inputs)) for (const entry of input.inputs) inputs.push({ ...entry, path: await file(entry.path, 'read') });
    input.inputs = inputs;
    if (!Array.isArray(input.outputs) || !input.outputs.length) throw new Error('Specify the document output files.');
    const outputs: string[] = [];
    for (const path of input.outputs) outputs.push(await file(path, 'write'));
    input.outputs = outputs;
  } else {
    input.path = await file(input.path, 'read');
    if (tool !== 'inspect_document') input.output = await file(input.output, 'write');
  }
  const requiresHuman = isParentApprovedChild(context) && (tool === 'author_document' || externalWrite);
  const reason = tool === 'author_document'
    ? 'Run document authoring JavaScript with host access, using the listed input and output files.'
    : 'Allow this external document operation on the listed files.';
  const capabilityId = 'capability:mcp:document:' + createHash('sha256').update(JSON.stringify([resource, input])).digest('hex');
  return { input, capabilityId, outsideScope, request: { reason, targets, actions, capabilityIds: [capabilityId], requiresHuman } };
}

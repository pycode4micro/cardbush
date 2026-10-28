import { uiText } from '../../i18n';
import type { ConversationEntry } from '@cardbush/bush-protocol';
import { fileUrl } from '../../shared/localPaths';
import { uploadAgentFile } from '../agents/uploadAgentFile';

type Attachment = NonNullable<ConversationEntry['attachments']>[number];
const maxSize = 64 * 1024 * 1024;

/** Reuse the Agent's file transfer; retain local originals for previews and local execution. */
export async function assistantExecutionAttachments(attachments: Attachment[], connectionId: string): Promise<Attachment[]> {
  if (!connectionId || !attachments.length) return attachments;
  const api = window.cardbushDesktop?.agents;
  if (!api) throw Error(uiText()('assistantAttachments.the_execution_host_is_unavailable'));
  if (attachments.some(item => item.type === 'folder')) throw Error(uiText()('assistantAttachments.remote_execution_cannot_transfer_entire_folders_select'));
  if (attachments.some(item => (item.size ?? 0) > maxSize)) throw Error(uiText()('assistantAttachments.attachments_must_not_exceed_64_mib'));
  await api.connect(connectionId);
  const storageKey = 'cardbush_assistant_attachment_session';
  const sessionId = localStorage.getItem(storageKey) || `assistant-files-${crypto.randomUUID()}`;
  localStorage.setItem(storageKey, sessionId);
  if (!await api.call(connectionId, 'sessions.get', { sessionId })) {
    await api.call(connectionId, 'sessions.create', { sessionId, title: uiText()('assistantAttachments.assistant_files'), projectId: null });
  }
  const uploaded: Attachment[] = [];
  for (const attachment of attachments) {
    const url = attachment.path && fileUrl(attachment.path);
    if (!url) throw Error(uiText()('assistantAttachments.could_not_read_attachment_value1', { value1: attachment.name }));
    const response = await fetch(url);
    if (!response.ok) throw Error(uiText()('assistantAttachments.could_not_read_attachment_value1', { value1: attachment.name }));
    if (Number(response.headers.get('content-length')) > maxSize) { await response.body?.cancel(); throw Error(uiText()('assistantAttachments.attachments_must_not_exceed_64_mib')); }
    const uploadId = crypto.randomUUID();
    const file = await response.blob();
    const result = await uploadAgentFile(file, chunk => api.call(connectionId, 'files.upload', {
      sessionId, uploadId, name: attachment.name, ...chunk,
    }) as Promise<{ path: string; nextOffset: number }>);
    uploaded.push({ ...attachment, execution: { connectionId, path: result.path } });
  }
  return uploaded;
}

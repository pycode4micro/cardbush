import type { ConversationEntry } from '@cardbush/bush-protocol';
import { fileUrl } from '../../shared/localPaths';
import { uploadAgentFile } from '../agents/uploadAgentFile';

type Attachment = NonNullable<ConversationEntry['attachments']>[number];
const maxSize = 64 * 1024 * 1024;

/** Reuse the Agent's file transfer; retain local originals for previews and local execution. */
export async function assistantExecutionAttachments(attachments: Attachment[], connectionId: string): Promise<Attachment[]> {
  if (!connectionId || !attachments.length) return attachments;
  const api = window.cardbushDesktop?.agents;
  if (!api) throw Error('执行主机连接不可用。');
  if (attachments.some(item => item.type === 'folder')) throw Error('远程执行暂不传输整个文件夹，请选择文件或先压缩为 ZIP。');
  if (attachments.some(item => (item.size ?? 0) > maxSize)) throw Error('附件不能超过 64 MiB。');
  await api.connect(connectionId);
  const storageKey = 'cardbush_assistant_attachment_session';
  const sessionId = localStorage.getItem(storageKey) || `assistant-files-${crypto.randomUUID()}`;
  localStorage.setItem(storageKey, sessionId);
  if (!await api.call(connectionId, 'sessions.get', { sessionId })) {
    await api.call(connectionId, 'sessions.create', { sessionId, title: 'Assistant files', projectId: null });
  }
  const uploaded: Attachment[] = [];
  for (const attachment of attachments) {
    const url = attachment.path && fileUrl(attachment.path);
    if (!url) throw Error(`无法读取附件：${attachment.name}`);
    const response = await fetch(url);
    if (!response.ok) throw Error(`无法读取附件：${attachment.name}`);
    if (Number(response.headers.get('content-length')) > maxSize) { await response.body?.cancel(); throw Error('附件不能超过 64 MiB。'); }
    const uploadId = crypto.randomUUID();
    const file = await response.blob();
    const result = await uploadAgentFile(file, chunk => api.call(connectionId, 'files.upload', {
      sessionId, uploadId, name: attachment.name, ...chunk,
    }) as Promise<{ path: string; nextOffset: number }>);
    uploaded.push({ ...attachment, execution: { connectionId, path: result.path } });
  }
  return uploaded;
}

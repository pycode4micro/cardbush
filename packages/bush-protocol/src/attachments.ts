import { z } from 'zod';

/** The original file and its optional position in the multimodal input are distinct. */
export const runtimeAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['image', 'video', 'audio', 'document', 'folder']),
  path: z.string().min(1).optional(),
  size: z.number().nonnegative().optional(),
  imageIndex: z.number().int().nonnegative().optional(),
});
export type RuntimeAttachment = z.infer<typeof runtimeAttachmentSchema>;

export const turnAttachmentContextSchema = z.object({
  messageId: z.string().min(1),
  timeContext: z.string(),
});

export function collectTurnAttachments(input: {
  messageId: string;
  attachments?: unknown;
  files?: string[];
  images?: string[];
  preserveImageIndexes?: boolean;
}): RuntimeAttachment[] {
  const attachments = (Array.isArray(input.attachments) ? input.attachments : []).flatMap(value => {
    const parsed = runtimeAttachmentSchema.safeParse(value);
    if (!parsed.success) return [];
    const item = parsed.data;
    if (!input.preserveImageIndexes) delete item.imageIndex;
    return [item];
  });
  const append = (path: string, imageIndex?: number) => {
    const existing = imageIndex === undefined ? attachments.find(item => item.path === path)
      : attachments.find(item => item.imageIndex === imageIndex) ??
        attachments.find(item => item.path === path && item.imageIndex === undefined);
    if (existing) {
      if (imageIndex !== undefined) existing.imageIndex = imageIndex;
      if (imageIndex !== undefined && /^data:image\//i.test(path)) delete existing.path;
      return;
    }
    const inline = /^data:image\//i.test(path);
    const name = inline ? `image-${(imageIndex ?? attachments.length) + 1}` : path.split(/[\\/]/).pop() || 'attachment';
    const type = imageIndex !== undefined || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name) ? 'image'
      : /\.(mp4|mov|mkv|webm)$/i.test(name) ? 'video'
      : /\.(mp3|wav|ogg|m4a|flac)$/i.test(name) ? 'audio' : 'document';
    attachments.push({ id: `${input.messageId}:attachment:${attachments.length}`, name, type, ...(!inline ? { path } : {}),
      ...(imageIndex !== undefined ? { imageIndex } : {}) });
  };
  input.images?.forEach((path, index) => append(path, index));
  input.files?.forEach(path => append(path));
  return attachments;
}

export function formatTurnAttachmentContext(timeContext: string, attachments: RuntimeAttachment[], localEnvironment = false): string {
  const images = attachments.filter(item => item.imageIndex !== undefined).sort((a, b) => a.imageIndex! - b.imageIndex!);
  const files = attachments.filter(item => item.imageIndex === undefined && item.path);
  const locator = (item: RuntimeAttachment) => item.path && !/^data:/i.test(item.path)
    ? JSON.stringify(item.path) : 'Inline image; awaiting original-file storage.';
  const content = [
    timeContext,
    files.length ? `Attached files:\n${files.map(locator).join('\n')}` : '',
    images.length ? `Attached images (in visual input order):\n${images.map(item => `${item.imageIndex! + 1}. ${locator(item)}`).join('\n')}` : '',
    attachments.length ? 'Attachment paths are for tools on the execution host. Image pixels supplied in the conversation do not open a document in an external application; use the corresponding file path when needed. Preserve originals and save edited results separately unless the user requests overwriting.' : '',
    localEnvironment ? 'Local attachments remain on the Runtime host and are unavailable to SSH terminal tools. Image pixels supplied in the conversation are still visible. Files must be transferred to the selected SSH host before processing them there; do not treat local paths as remote files.' : '',
  ].filter(Boolean).join('\n');
  return content ? `<turn_runtime_context>\n${content}\n</turn_runtime_context>` : '';
}

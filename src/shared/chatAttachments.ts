import type { ChatAttachment } from '../types';
import { basename, isAudioPath, isImagePath, isVideoPath, splitExplicitAttachmentMentions } from './localPaths';

export function splitStreamAttachmentMentions(content: string) {
  const images: Array<{ path: string }> = [];
  const files: string[] = [];
  const { text: userInput, paths } = splitExplicitAttachmentMentions(content);
  for (const mention of paths) {
    if (!mention.startsWith('ssh://') && isImagePath(mention)) {
      images.push({ path: mention });
    } else {
      files.push(mention);
    }
  }
  return {
    displayInput: userInput,
    userInput:
      userInput ||
      (images.length > 0 || files.length > 0
        ? 'Please review the attached file(s).'
        : content.trim()),
    images,
    files,
  };
}

export async function chatAttachmentsFromOutbound(
  outbound: ReturnType<typeof splitStreamAttachmentMentions>,
  inspectLocal = true,
): Promise<ChatAttachment[]> {
  const inspected = inspectLocal && outbound.files.length > 0 ? await window.cardbushDesktop
    ?.inspectAttachments?.(outbound.files)
    .catch(() => []) : [];
  const kindByPath = new Map(
    (inspected ?? []).map((item) => [
      item.path.replace(/\\/g, '/').toLowerCase(),
      item,
    ]),
  );
  return [
    ...outbound.images.map((image) => ({
      id: `attachment-${crypto.randomUUID()}`,
      name: basename(image.path),
      path: image.path,
      type: 'image' as const,
    })),
    ...outbound.files.map((pathValue) => {
      const metadata = kindByPath.get(pathValue.replace(/\\/g, '/').toLowerCase());
      return {
        id: `attachment-${crypto.randomUUID()}`,
        name: basename(pathValue),
        path: pathValue,
        ...(Number.isFinite(metadata?.size) ? { size: metadata!.size } : {}),
        type: metadata?.kind === 'folder'
          ? 'folder' as const
          : isVideoPath(pathValue)
            ? 'video' as const
            : isAudioPath(pathValue)
              ? 'audio' as const
              : 'document' as const,
      };
    }),
  ];
}

export function streamAttachmentsForVision(
  attachments: ReturnType<typeof splitStreamAttachmentMentions>,
  standardImageInputEnabled: boolean,
) {
  if (standardImageInputEnabled) {
    return attachments;
  }
  return {
    ...attachments,
    images: [],
    files: [
      ...attachments.files,
      ...attachments.images.map((image) => image.path).filter(Boolean),
    ],
  };
}

export function streamAttachmentsFromChatAttachments(
  attachments: ChatAttachment[] | undefined,
  standardImageInputEnabled: boolean,
) {
  const paths = (attachments ?? []).flatMap((attachment) =>
    attachment.path?.trim() ? [attachment.path.trim()] : [],
  );
  const images = paths
    .filter(path => !path.startsWith('ssh://') && isImagePath(path))
    .map((path) => ({ path }));
  const files = paths.filter((path) => path.startsWith('ssh://') || !isImagePath(path));
  return streamAttachmentsForVision(
    { displayInput: '', userInput: '', images, files },
    standardImageInputEnabled,
  );
}

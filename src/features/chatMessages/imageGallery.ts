import type { ChatMessage, ChatToolArtifact, ChatToolExecution } from '../../types';
import { fileUrl, isAbsoluteLocalPath, mediaResourceUrl, resourceBasename } from '../../shared/localPaths';
import { remapProjectPath, type ProjectPathAlias } from '../conversationScope';
import { messageMediaReferences } from '../chat/workSummaryOutputs';
import { markdownLocalFileReference } from './fileReferences';
import { localMediaPath } from './mediaPresentation';

export type ImagePreviewSource = {
  src: string;
  name: string;
  path?: string;
  snapshotPath?: string;
  snapshotId?: string;
  naturalWidth?: number;
  naturalHeight?: number;
};
export type ImageGalleryScope = 'session' | 'attachments' | 'directory' | 'workspace';

export function isGalleryImage(path: string) {
  return /\.(png|apng|avif|jpe?g|webp|gif|bmp|ico|svg)$/i.test(resourceBasename(path)) || /^data:image\//i.test(path);
}

export function galleryImage(path: string, name = ''): ImagePreviewSource {
  return { path, name: name || resourceBasename(path) || 'Image',
    src: /^(?:https?:|data:|blob:)/i.test(path) ? path : fileUrl(path) };
}

export function galleryImageKey(image: ImagePreviewSource) {
  const path = localMediaPath(image.snapshotPath || image.path || image.src).replaceAll('\\', '/');
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
}

export function toolGalleryImage(artifact: ChatToolArtifact): ImagePreviewSource {
  return { path: artifact.path, name: artifact.name || resourceBasename(artifact.path),
    src: mediaResourceUrl(artifact.snapshotPath ?? artifact.path), snapshotPath: artifact.snapshotPath,
    snapshotId: artifact.snapshotPath ? artifact.id : undefined };
}

/** Preserve the current order, including when later transcript snapshots arrive. */
export function appendGalleryImages(current: ImagePreviewSource[], incoming: ImagePreviewSource[]) {
  const seen = new Set(current.map(galleryImageKey));
  const added = incoming.filter(image => {
    const key = galleryImageKey(image);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return added.length ? [...current, ...added] : current;
}

export function sessionGalleryImages(messages: ChatMessage[], workspaceRoot = '', aliases: ProjectPathAlias[] = [],
  hydrated?: (execution: ChatToolExecution, message: ChatMessage) => ChatToolExecution | undefined) {
  const images: ImagePreviewSource[] = [];
  const add = (source: string | undefined, name = '') => {
    if (!source) return;
    const decoded = localMediaPath(source);
    const path = remapProjectPath(isAbsoluteLocalPath(decoded) || /^(?:https?:|data:image\/|blob:)/i.test(decoded)
      ? decoded : markdownLocalFileReference(decoded, workspaceRoot)?.path ?? '', aliases);
    if (path) images.push(galleryImage(path, name));
  };
  const visit = (message: ChatMessage) => {
    if (message.role !== 'user' && message.role !== 'assistant') return;
    message.loopHistory?.forEach(visit);
    for (const attachment of message.attachments ?? []) {
      if (attachment.type === 'image') add(attachment.path, attachment.name);
    }
    for (const reference of messageMediaReferences(message)) {
      // Authored HTML embeds use the same Markdown syntax but belong to the BI viewer.
      if (reference.type === 'image' && !/\.html?$/i.test(resourceBasename(reference.path))) add(reference.path);
    }
    for (const execution of message.toolExecutions ?? []) {
      for (const artifact of (hydrated?.(execution, message) ?? execution).artifacts ?? []) {
        if (artifact.type !== 'image') continue;
        if (artifact.snapshotPath) images.push(toolGalleryImage(artifact));
        else add(artifact.path, artifact.name);
      }
    }
  };
  messages.forEach(visit);
  return appendGalleryImages([], images);
}

export function imageDirectory(image: ImagePreviewSource) {
  const path = localMediaPath(image.path || image.src).replaceAll('\\', '/');
  if (!isAbsoluteLocalPath(path)) return '';
  const slash = path.lastIndexOf('/');
  return slash === 0 ? '/' : slash === 2 && path[1] === ':' ? path.slice(0, 3) : path.slice(0, slash);
}

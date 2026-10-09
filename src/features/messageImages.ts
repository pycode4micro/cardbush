import {
  isAbsoluteLocalPath,
  isAudioPath,
  isImagePath,
  isVideoPath,
  stripWrappingQuotes,
} from '../shared/localPaths';

export function splitMessageMedia(content: string) {
  const imagePaths: string[] = [];
  const videoPaths: string[] = [];
  const audioPaths: string[] = [];
  const textLines: string[] = [];
  for (const { line, media } of messageMediaLines(content)) {
    if (!media) {
      textLines.push(line);
      continue;
    }
    if (media.type === 'image') imagePaths.push(media.path);
    if (media.type === 'video') videoPaths.push(media.path);
    if (media.type === 'audio') audioPaths.push(media.path);
  }
  return {
    imagePaths,
    videoPaths,
    audioPaths,
    text: textLines.join('\n').trim(),
  };
}

export type MessageMediaItem = {
  path: string;
  type: 'image' | 'video' | 'audio';
};

export type MessageMediaBlock =
  | { kind: 'text'; content: string }
  | { kind: 'media'; items: MessageMediaItem[] };

/**
 * Preserves the authored relationship between prose and standalone media paths.
 * Consecutive media lines share one visual group, while prose between them keeps
 * separate groups in the same order as the source message.
 */
export function splitMessageMediaBlocks(content: string): MessageMediaBlock[] {
  const blocks: MessageMediaBlock[] = [];
  let textLines: string[] = [];
  let mediaItems: MessageMediaItem[] = [];
  const flushText = () => {
    // Remove blank boundary lines, but retain indentation inside code blocks.
    const value = textLines.join('\n').replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
    if (value.trim()) blocks.push({ kind: 'text', content: value });
    textLines = [];
  };
  const flushMedia = () => {
    if (mediaItems.length > 0) blocks.push({ kind: 'media', items: mediaItems });
    mediaItems = [];
  };
  for (const { line, media } of messageMediaLines(content)) {
    if (media) {
      flushText();
      mediaItems.push(media);
      continue;
    }
    // A blank line between images is spacing, not a new gallery.
    if (mediaItems.length && !line.trim()) continue;
    flushMedia();
    textLines.push(line);
  }
  flushText();
  flushMedia();
  return blocks;
}

function* messageMediaLines(content: string) {
  let fence: { marker: string; length: number } | undefined;
  for (const line of content.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined;
      }
      yield { line, media: null };
    } else if (marker) {
      fence = { marker: marker[1][0], length: marker[1].length };
      yield { line, media: null };
    } else {
      // Code paths are authored examples, not inline media. Extracting one
      // would split a fence across independent Markdown renderers.
      const code = /^(?: {4}|\t)/.test(line) || /^\s*`/.test(line);
      yield { line, media: code ? null : mediaPathFromMessageLine(line) };
    }
  }
}

function mediaPathFromMessageLine(value: string) {
  const trimmed = value.trim();
  const pathValue = stripWrappingQuotes(
    trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed,
  );
  if (
    !isAbsoluteLocalPath(pathValue) &&
    !/^file:\/\//i.test(pathValue) &&
    !/^https?:\/\//i.test(pathValue)
  ) {
    return null;
  }
  if (isImagePath(pathValue)) return { path: pathValue, type: 'image' as const };
  if (isVideoPath(pathValue)) return { path: pathValue, type: 'video' as const };
  if (isAudioPath(pathValue)) return { path: pathValue, type: 'audio' as const };
  return null;
}

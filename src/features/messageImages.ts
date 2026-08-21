import {
  isAbsoluteLocalPath,
  isAudioPath,
  isImagePath,
  isVideoPath,
  stripWrappingQuotes,
} from '../shared/localPaths';

export function splitMessageImages(content: string) {
  const media = splitMessageMedia(content);
  return {
    imagePaths: media.imagePaths,
    text: media.text,
  };
}

export function splitMessageMedia(content: string) {
  const imagePaths: string[] = [];
  const videoPaths: string[] = [];
  const audioPaths: string[] = [];
  const textLines: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const media = mediaPathFromMessageLine(line);
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

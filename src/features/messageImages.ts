import { isAbsoluteLocalPath, isImagePath, stripWrappingQuotes } from '../shared/localPaths';

export { isImagePath, stripWrappingQuotes };

export function splitMessageImages(content: string) {
  const imagePaths: string[] = [];
  const textLines: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const pathValue = imagePathFromMessageLine(line);
    if (pathValue) {
      imagePaths.push(pathValue);
    } else {
      textLines.push(line);
    }
  }
  return {
    imagePaths,
    text: textLines.join('\n').trim(),
  };
}

function imagePathFromMessageLine(value: string) {
  const trimmed = value.trim();
  const pathValue = stripWrappingQuotes(
    trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed,
  );
  if (!isAbsoluteLocalPath(pathValue) && !/^file:\/\//i.test(pathValue)) {
    return '';
  }
  return isImagePath(pathValue) ? pathValue : '';
}

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

export function isImagePath(value: string) {
  return /\.(png|jpe?g|webp|gif|bmp|ico)$/i.test(stripWrappingQuotes(value.trim()));
}

export function stripWrappingQuotes(value: string) {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === '`' && last === '`')
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
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

function isAbsoluteLocalPath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

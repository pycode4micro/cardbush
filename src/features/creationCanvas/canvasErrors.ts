/** Keep IPC envelopes and filesystem diagnostics out of canvas notifications. */
export function canvasErrorMessage(error: unknown, language: 'zh' | 'en') {
  const message = String(error instanceof Error ? error.message : error)
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').replace(/^Error:\s*/, '');
  if (/\b(?:ENOENT|ENOTDIR)\b/.test(message)) {
    const path = message.match(/\b(?:stat|open|lstat|realpath|scandir)\s+['"](.+?)['"]/)?.[1];
    const name = path?.split(/[\\/]/).pop();
    return language === 'zh'
      ? `找不到${name ? `文件「${name}」` : '引用的文件'}。请检查文件是否已移动，或修正文档中的引用路径后重试。`
      : `Cannot find ${name ? `“${name}”` : 'the referenced file'}. Check whether it was moved or correct the document’s file reference, then retry.`;
  }
  if (/\b(?:EACCES|EPERM)\b/.test(message)) return language === 'zh'
    ? '暂时无法访问文件。请检查文件权限或是否被其他程序占用后重试。'
    : 'Cannot access the file. Check its permissions or whether another program is using it, then retry.';
  return message.replace(/^CANVAS_[A-Z_]+:\s*/, '');
}

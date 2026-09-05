// Bound parsing/DOM work without dropping the readable, already byte-bounded content.
export function shouldUsePlainTextPreview(content: string): boolean {
  if (content.length > 200_000) return true;
  let lines = 1, lineLength = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '\n' || character === '\r') {
      if (character === '\r' && content[index + 1] === '\n') index += 1;
      if (++lines > 4000) return true;
      lineLength = 0;
    } else if (++lineLength > 10_000) return true;
  }
  return false;
}

export function textPreviewErrorMessage(error: unknown, language: 'zh' | 'en'): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('[text_preview_binary]')) {
    return language === 'zh' ? '这是二进制文件，无法作为文本预览。' : 'This is a binary file and cannot be previewed as text.';
  }
  if (message.includes('[text_preview_encoding]')) {
    return language === 'zh'
      ? '无法可靠识别文本编码，或文件含有损坏的字符。原文件未修改。'
      : 'The text encoding is unsupported or contains invalid characters. The original file is unchanged.';
  }
  return message;
}

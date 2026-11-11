export const minimumInspectorWidth = 380;
export const minimumConversationWidth = 340;

export function fitInspectorSplit(preferred: number, available: number) {
  const conversationWidth = Math.min(minimumConversationWidth, Math.ceil(available / 2));
  return Math.max(0, Math.min(preferred, available - conversationWidth));
}

export function conversationPaneMinimum(
  _windowMaximized: boolean,
  _viewportWidth: number,
) {
  return minimumConversationWidth;
}

export function inspectorMaximum(
  _windowMaximized: boolean,
  viewportWidth: number,
) {
  return Math.max(minimumInspectorWidth, viewportWidth);
}

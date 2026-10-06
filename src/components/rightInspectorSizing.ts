export const minimumInspectorWidth = 380;
export const minimumConversationWidth = 340;

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

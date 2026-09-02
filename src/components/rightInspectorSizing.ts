export const minimumInspectorWidth = 380;

const restoredConversationPaneMinimum = 440;
const maximizedConversationPaneMinimum = 340;
const maximizedConversationPanePreferredRatio = 0.18;
const maximizedConversationPaneMaximum = 440;
const restoredInspectorMaximum = 900;

export function conversationPaneMinimum(
  windowMaximized: boolean,
  viewportWidth: number,
) {
  if (!windowMaximized) return restoredConversationPaneMinimum;
  return Math.min(
    maximizedConversationPaneMaximum,
    Math.max(
      maximizedConversationPaneMinimum,
      viewportWidth * maximizedConversationPanePreferredRatio,
    ),
  );
}

export function inspectorMaximum(
  windowMaximized: boolean,
  viewportWidth: number,
) {
  return windowMaximized
    ? Math.max(minimumInspectorWidth, viewportWidth)
    : restoredInspectorMaximum;
}

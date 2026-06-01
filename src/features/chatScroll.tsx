import type { ChatMessage } from '../types';

export const scrollBottomLockTolerance = 72;
export const scrollBottomWheelLockTolerance = 4;
export const scrollBottomWheelFreezeMs = 1600;
export const manualScrollDetachHoldMs = 4200;

export type ScrollBottomMetrics = {
  visualNearBottom: boolean;
  visualAtBottom: boolean;
  visualBottomDistance: number;
  absoluteBottomDistance: number;
  absoluteAtBottom: boolean;
};

export function MessageListFooter() {
  return <div className="message-list-footer" />;
}

export function streamingAssistantMessage(
  messages: ChatMessage[],
  activeTurnId: string,
) {
  const normalizedTurnId = activeTurnId.trim();
  if (!normalizedTurnId) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.turnId?.trim() === normalizedTurnId) {
      return { message, index };
    }
  }
  return null;
}

export function lastAssistantMessage(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant') {
      return { message, index };
    }
  }
  return null;
}

export function isScrollerNearVisualBottom(
  scroller: HTMLElement,
  composerDockHeight: number,
  streamStatusHeight: number,
) {
  return (
    visualBottomScrollTop(scroller, composerDockHeight, streamStatusHeight) -
      scroller.scrollTop <=
    scrollBottomLockTolerance
  );
}

export function absoluteBottomScrollTop(scroller: HTMLElement) {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

export function visualBottomScrollTop(
  scroller: HTMLElement,
  _composerDockHeight: number,
  _streamStatusHeight: number,
) {
  // The Virtuoso footer already reserves the composer/status gap. Keeping a
  // second "visual bottom" above the real scroll bottom makes wheel and
  // follow-state guards fight each other near the tail.
  return absoluteBottomScrollTop(scroller);
}

export function isMessageTailVisible(
  scroller: HTMLElement,
  messageId: string,
  options: {
    composerDockHeight: number;
    streamStatusHeight: number;
    tolerance: number;
  },
) {
  const item = scroller.querySelector(
    `[data-message-id="${selectorEscape(messageId)}"]`,
  );
  if (!(item instanceof HTMLElement)) {
    return false;
  }
  const scrollerRect = scroller.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const visibleBottom =
    scrollerRect.bottom -
    Math.max(0, options.composerDockHeight) -
    Math.max(0, options.streamStatusHeight) -
    18 +
    options.tolerance;
  return itemRect.bottom <= visibleBottom && itemRect.bottom >= scrollerRect.top + 36;
}

function selectorEscape(value: string) {
  return value.replace(/["\\]/g, '\\$&');
}

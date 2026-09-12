import { createContext } from 'react';
import type { ChatMessage } from '../../types';
import type { BrowserPromptReference } from '../../shared/promptReferences';
import { isBrowserReferenceUrl } from '../../shared/promptReferences';
import type { InspectorTab } from '../inspector/inspectorTabs';
import type { InspectorNavigationState } from '../inspector/InspectorWebview';

/** Derived directly from this window's inspector and current conversation. */
export const ComposerReferenceContext = createContext<{
  sessionId: string;
  browserTabs: BrowserPromptReference[];
  messages: ChatMessage[];
}>({ sessionId: '', browserTabs: [], messages: [] });

export function referenceableUserMessages(messages: ChatMessage[], sessionId: string): ChatMessage[] {
  return messages.filter(message => message.role === 'user' && Boolean(message.turnId && message.messageId) &&
    (!message.conversationId || message.conversationId === sessionId) &&
    !message.metadata?.__bush_superseded && !['pending', 'failed'].includes(String(message.metadata?.message_delivery ?? '')) &&
    !['pending', 'queued', 'failed'].includes(String(message.metadata?.guidance_delivery ?? '')) &&
    message.metadata?.visibility !== 'internal' && Boolean(message.content.trim() || message.attachments?.length));
}

export function inspectorBrowserReferences(tabs: InspectorTab[], navigation: Record<string, InspectorNavigationState>): BrowserPromptReference[] {
  return tabs.flatMap(tab => {
    if (tab.kind !== 'resource' || !isBrowserReferenceUrl(tab.detail.target)) return [];
    const current = navigation[tab.id];
    const url = current?.url || tab.detail.target;
    if (!isBrowserReferenceUrl(url)) return [];
    return [{ kind: 'browser', tabId: tab.id, url, title: current?.title || tab.detail.title || url }];
  });
}

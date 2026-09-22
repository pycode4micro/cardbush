import type { RuntimePermissionAnswer } from '@cardbush/bush-protocol';
import type { ProtocolRuntimeClient } from '../runtime-client/ProtocolRuntimeClient';
import { createDesktopRuntimeSession } from '../runtime-client/ElectronRuntimeSession';
import { defaultRuntimeInteractions, type RuntimeInteractions } from '../runtime-client/RuntimeInteractionBridge';

/** Host-owned I/O injected into the same conversation readers and event consumer. */
export interface ConversationRuntime {
  client: ProtocolRuntimeClient;
  resolveExtract?: (id: string, contextWindowTokens?: number) => Promise<{ path: string; tokens: number }>;
  interactions?: RuntimeInteractions;
  answerPermission(answer: RuntimePermissionAnswer): Promise<unknown>;
  dispose(): void;
}
export const conversationRuntime = (runtime?: ConversationRuntime): ConversationRuntime => runtime ?? createDesktopRuntimeSession();
export const conversationInteractions = (runtime: ConversationRuntime) => runtime.interactions ?? defaultRuntimeInteractions;

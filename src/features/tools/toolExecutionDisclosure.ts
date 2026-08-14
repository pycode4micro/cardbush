import type { ChatMessage, ChatToolExecution } from '../../types';

export const toolExecutionDisclosureStorageKey =
  'cardbush.tool_execution_disclosure.v1';

type DisclosureEntry = {
  expanded: boolean;
  updatedAt: number;
};

type DisclosureStore = Record<string, DisclosureEntry>;

const maxStoredDisclosureEntries = 320;

export function toolExecutionDisclosureId(
  message: ChatMessage,
  executions: ChatToolExecution[],
) {
  const firstExecution = executions[0];
  const groupAnchor = Number.isFinite(firstExecution?.contentOffset)
    ? `offset:${firstExecution.contentOffset}`
    : `tool:${firstExecution?.id ?? 'none'}`;
  return [
    message.conversationId?.trim() || 'conversation',
    message.turnId?.trim() || 'turn',
    message.id,
    groupAnchor,
  ].join('|');
}

export function assistantMessageDisclosureId(message: ChatMessage) {
  return [
    message.conversationId?.trim() || 'conversation',
    message.turnId?.trim() || 'turn',
    message.id,
    'assistant-content',
  ].join('|');
}

export function defaultToolExecutionExpanded(
  _active: boolean,
  stored: boolean | undefined,
) {
  return stored ?? false;
}

export function readToolExecutionDisclosure(
  storage: Pick<Storage, 'getItem'> | null,
  id: string,
) {
  if (!storage || !id) return undefined;
  try {
    const entry = disclosureStore(storage.getItem(toolExecutionDisclosureStorageKey))[id];
    return typeof entry?.expanded === 'boolean' ? entry.expanded : undefined;
  } catch {
    return undefined;
  }
}

export function writeToolExecutionDisclosure(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  id: string,
  expanded: boolean,
) {
  if (!storage || !id) return;
  try {
    const entries = disclosureStore(storage.getItem(toolExecutionDisclosureStorageKey));
    entries[id] = { expanded, updatedAt: Date.now() };
    const boundedEntries = Object.fromEntries(
      Object.entries(entries)
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, maxStoredDisclosureEntries),
    );
    storage.setItem(toolExecutionDisclosureStorageKey, JSON.stringify(boundedEntries));
  } catch {
    // Storage may be disabled or full. Disclosure still works for this mount.
  }
}

function disclosureStore(value: string | null): DisclosureStore {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, DisclosureEntry] => {
        const candidate = entry[1] as Partial<DisclosureEntry> | null;
        return Boolean(
          candidate &&
            typeof candidate.expanded === 'boolean' &&
            Number.isFinite(candidate.updatedAt),
        );
      }),
    );
  } catch {
    return {};
  }
}

import { fromMarkdown } from 'mdast-util-from-markdown';
import type { ChatAttachment, ChatMessage } from '../../types';
import { isAbsoluteLocalPath, resourceBasename } from '../../shared/localPaths';
import { remapProjectPath, type ProjectPathAlias } from '../conversationScope';
import { markdownLocalFileReference } from '../chatMessages/fileReferences';
import { localMediaPath, mediaPresentationKey } from '../chatMessages/mediaPresentation';
import { normalizeMarkdownContentForDisplay } from '../chatMessages/markdownFormat';
import { splitMessageMedia } from '../messageImages';
import type { ConversationChangeReport, ToolFileChange } from '../tools/toolChangeReports';

export type WorkSummaryOutput = {
  key: string;
  path: string;
  name: string;
  type: 'document' | 'image' | 'video' | 'audio';
  change?: ToolFileChange;
};

type MediaReference = { path: string; type: WorkSummaryOutput['type'] };
type MarkdownNode = {
  type: string;
  url?: string;
  identifier?: string;
  value?: string;
  children?: MarkdownNode[];
};
const messageMediaCache = new WeakMap<ChatMessage, { content: string; references: MediaReference[] }>();

function mediaType(path: string): WorkSummaryOutput['type'] | undefined {
  const name = resourceBasename(path);
  if (/\.(png|apng|avif|jpe?g|webp|gif|bmp|ico|svg)$/i.test(name) || /^data:image\//i.test(path)) return 'image';
  if (/\.(mp4|m4v|webm|ogv|mov|mkv|avi|mpeg|mpg)$/i.test(name) || /^data:video\//i.test(path)) return 'video';
  if (/\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|aiff?|wma)$/i.test(name) || /^data:audio\//i.test(path)) return 'audio';
  return undefined;
}

/** Read authored media nodes, not filenames mentioned in prose, examples or tool logs. */
export function messageMediaReferences(message: ChatMessage): MediaReference[] {
  const cached = messageMediaCache.get(message);
  if (cached?.content === message.content) return cached.references;
  const tree: MarkdownNode = fromMarkdown(normalizeMarkdownContentForDisplay(message.content));
  const definitions = new Map<string, string>();
  const collectDefinitions = (node: MarkdownNode) => {
    if (node.type === 'definition' && node.identifier && node.url && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    node.children?.forEach(collectDefinitions);
  };
  collectDefinitions(tree);
  const references: MediaReference[] = [];
  const visit = (node: MarkdownNode) => {
    if (['code', 'inlineCode', 'html', 'definition'].includes(node.type)) return;
    if (['image', 'link', 'imageReference', 'linkReference'].includes(node.type)) {
      const path = node.url ?? definitions.get(node.identifier ?? '');
      const type = path ? mediaType(path) ?? (node.type.startsWith('image') ? 'image' : undefined) : undefined;
      if (path && type) references.push({ path, type });
    }
    // Standalone media paths already render as media strips in the transcript.
    if (node.type === 'paragraph' && node.children?.every(child => child.type === 'text')) {
      const media = splitMessageMedia(node.children.map(child => child.value ?? '').join(''));
      for (const type of ['image', 'video', 'audio'] as const) {
        references.push(...media[`${type}Paths`].map(path => ({ path, type })));
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  messageMediaCache.set(message, { content: message.content, references });
  return references;
}

/** A view of existing conversation facts; no filesystem scan or second artifact store. */
export function workSummaryOutputs(
  messages: ChatMessage[],
  changeReports: ConversationChangeReport[],
  workspaceRoot = '',
  pathAliases: ProjectPathAlias[] = [],
): WorkSummaryOutput[] {
  const segments: ChatMessage[] = [];
  const flatten = (message: ChatMessage) => {
    message.loopHistory?.forEach(flatten);
    segments.push(message);
  };
  messages.forEach(flatten);
  const messageOrder = new Map(segments.map((message, index) => [message.id, index]));
  const turnOrder = new Map(segments.filter(message => message.turnId).map(message => [message.turnId, messageOrder.get(message.id)!]));
  const byPath = new Map<string, WorkSummaryOutput & { order: number; sequence: number }>();
  let sequence = 0;
  const add = (source: string, order: number, attachment?: Pick<ChatAttachment, 'name' | 'type'>, change?: ToolFileChange) => {
    const decoded = localMediaPath(source);
    if (!decoded || attachment?.type === 'folder') return;
    const path = remapProjectPath(
      isAbsoluteLocalPath(decoded) || /^(?:https?:\/\/|data:(?:image|video|audio)\/)/i.test(decoded)
        ? decoded : markdownLocalFileReference(decoded, workspaceRoot)?.path ?? '',
      pathAliases,
    );
    // Relative change paths are still reviewable when the conversation has no workspace.
    const target = path || (change && !/^[a-z][a-z0-9+.-]*:/i.test(decoded) ? decoded : '');
    if (!target) return;
    const key = mediaPresentationKey(target);
    const previous = byPath.get(key);
    const type = mediaType(target) ?? (attachment?.type !== 'document' ? attachment?.type : undefined) ?? previous?.type ?? 'document';
    const next = {
      key, path: target,
      name: attachment?.name?.trim() || previous?.name || resourceBasename(target) || type,
      type, change: change ?? previous?.change, order, sequence: sequence++,
    };
    if (previous && previous.order > order) {
      byPath.set(key, { ...previous, change: previous.change ?? change });
    } else byPath.set(key, next);
  };
  changeReports.forEach((report, index) => {
    const order = messageOrder.get(report.messageId) ?? turnOrder.get(report.turnId) ?? (index - changeReports.length);
    report.files.forEach(file => add(file.path, order + 0.25, undefined, file));
  });
  segments.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    for (const execution of message.toolExecutions ?? []) {
      for (const artifact of execution.artifacts ?? []) add(artifact.path, index + 0.5, artifact);
    }
    for (const attachment of message.attachments ?? []) {
      if (attachment.path) add(attachment.path, index + 0.75, attachment);
    }
    for (const reference of messageMediaReferences(message)) {
      add(reference.path, index + 0.75, { name: '', type: reference.type });
    }
  });
  return [...byPath.values()]
    .sort((a, b) => b.order - a.order || b.sequence - a.sequence)
    .map(({ order: _order, sequence: _sequence, ...output }) => output);
}

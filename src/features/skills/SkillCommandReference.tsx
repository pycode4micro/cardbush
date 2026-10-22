import { Fragment, useContext, type ReactNode } from 'react';
import { BookOpen } from 'lucide-react';
import { fileUrl, isAbsoluteLocalPath } from '../../shared/localPaths';
import type { PluginCommandSummary } from '../../types';
import { ConversationHostContext } from '../conversationHost';
import { openInspector } from '../inspector/inspectorEvents';
import { PromptReferenceFallback } from '../composer/PromptReferenceLink';
import { skillMarkdownPresentation, skillPromptParts } from './skillReferences';

export function SkillCommandReference({ command, path, children }: { command: string; path: string; children: ReactNode }) {
  const host = useContext(ConversationHostContext);
  const content = <><BookOpen size={16}/><span>{children}</span></>;
  const props = { className: 'context-reference-token skill-reference-token', 'data-skill-reference': command, title: [command, path].filter(Boolean).join('\n') };
  if (!isAbsoluteLocalPath(path)) return <span {...props}>{content}</span>;
  if (host) return <button {...props} type="button" onClick={() => host.openFile(path)}>{content}</button>;
  return <a {...props} href={fileUrl(path)} onClick={event => {
    event.preventDefault();
    openInspector(path, typeof children === 'string' ? children : undefined);
  }}>{content}</a>;
}

/** The lazy Markdown fallback uses the same identity and never flashes a raw command. */
export function SkillPromptFallback({ content, commands = [] }: { content: string; commands?: PluginCommandSummary[] }) {
  const invocation = skillMarkdownPresentation(content, commands).invocation;
  return <>{skillPromptParts(content, [], commands).map(part => <Fragment key={part.start}>
    {part.skillCommand && part.skillReference && part.start === invocation?.start
      ? <SkillCommandReference command={part.text} path={part.skillReference.path}>{part.skillReference.title}</SkillCommandReference>
      : <PromptReferenceFallback content={part.text}/>}
  </Fragment>)}</>;
}

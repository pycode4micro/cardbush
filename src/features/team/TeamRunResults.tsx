import { uiText } from '../../i18n';
import type { TeamRun } from '@cardbush/bush-protocol';
import { MarkdownContent, MessageFileReferenceScope } from '../chatMessages';
import { teamNodeTitle } from './teamFlowGraph';

/** Terminal steps are the deliverables. After interruption, retain the completed frontier. */
export function TeamRunResults({ run, language, workspaceRoot, onOpenConversation }: {
  run: TeamRun; language: string; workspaceRoot?: string; onOpenConversation?: (id: string) => void;
}) {
  const completed = new Set(run.nodes.filter(node => node.status === 'completed' && node.output.trim()).map(node => node.id));
  const consumed = new Set(run.workflow.nodes.filter(node => completed.has(node.id)).flatMap(node => node.depends_on));
  const outputs = run.nodes.filter(node => completed.has(node.id) && !consumed.has(node.id));
  if (run.status === 'running' || !outputs.length) return null;

  return <section className="team-run-results" aria-label={uiText(language)('teamRunResults.runResults')}>
    <header><strong>{run.status === 'completed' ? (uiText(language)('teamRunResults.runResults')) : (uiText(language)('teamRunResults.retainedPartialResults'))}</strong>
      {onOpenConversation && <button type="button" onClick={() => onOpenConversation(run.parentSessionId)}>{uiText(language)('teamRunResults.openConversation')}</button>}</header>
    <MessageFileReferenceScope workspaceRoot={workspaceRoot}>{outputs.map(node => <details key={node.id} open={outputs.length === 1}>
      <summary>{teamNodeTitle(run.workflow.nodes.find(item => item.id === node.id)!, run.agents.map(item => item.definition))}</summary>
      <div className="team-run-result-content"><MarkdownContent content={node.output} language={language}/></div>
    </details>)}</MessageFileReferenceScope>
  </section>;
}

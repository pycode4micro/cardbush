import type { TeamRun } from '@cardbush/bush-protocol';
import { uiText, type MessageKey } from '../../i18n';
import { MarkdownContent } from '../chatMessages';
import { teamDeliveryLabel } from './teamFlowGraph';

/** Render Agent declarations separately from host-observed execution facts. */
export function TeamNodeDelivery({ node, language }: { node: TeamRun['nodes'][number]; language: string }) {
  const t = uiText(language), submission = node.delivery?.submission, facts = node.diagnostics;
  const checkLabels: Record<string, MessageKey> = { passed: 'teamDelivery.checkPassed', failed: 'teamDelivery.checkFailed', not_checked: 'teamDelivery.notChecked' };
  return <section className="team-node-delivery" aria-label={t('teamDelivery.title')}>
    <strong>{t('teamDelivery.state', { status: teamDeliveryLabel(node.delivery?.status, language) })}</strong>
    <p>{t('teamDelivery.authority')}</p>
    {submission && <>
      <MarkdownContent content={submission.summary} language={language}/>
      {!!submission.artifacts.length && <ul aria-label={t('teamDelivery.artifacts')}>{submission.artifacts.map((reference, index) => <li key={index}>{reference}</li>)}</ul>}
      {!!submission.checks.length && <ul aria-label={t('teamDelivery.checks')}>{submission.checks.map((check, index) => <li key={index}>
        <strong>{t(checkLabels[check.result])}</strong> {check.criterion}<p>{check.evidence}</p>
      </li>)}</ul>}
    </>}
    {facts && <details><summary>{t('teamDelivery.diagnostics')}</summary><dl>
      <dt>{t('teamDelivery.attempt')}</dt><dd>{node.attempt ?? 0}</dd>
      <dt>{t('teamDelivery.reason')}</dt><dd>{facts.reason || facts.finishReason || '—'}</dd>
      <dt>{t('teamDelivery.calls')}</dt><dd>{facts.toolCalls}</dd>
      <dt>{t('teamDelivery.receipts')}</dt><dd>{facts.toolReceipts}</dd>
      <dt>{t('teamDelivery.inputTokens')}</dt><dd>{facts.inputTokens ?? '—'}</dd>
    </dl></details>}
    {!!node.attempts?.length && <details><summary>{t('teamDelivery.previousAttempts', { count: node.attempts.length })}</summary>
      {node.attempts.map((attempt, index) => <TeamNodeDelivery key={attempt.attemptId ?? index} node={{ id: node.id, ...attempt }} language={language}/>)}</details>}
  </section>;
}

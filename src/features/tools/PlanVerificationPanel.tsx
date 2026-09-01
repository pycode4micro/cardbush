import { AlertCircle, ShieldCheck } from 'lucide-react';

import type { AppLanguage, ChatToolExecution } from '../../types';
import { asRecord, nonEmptyString } from './toolPayload';

export type VerificationAssertionItem = {
  label: string;
  status: string;
  summary: string;
};

export type PlanVerificationInfo = {
  failed: boolean;
  status: string;
  summary: string;
  verificationLevel: string;
  assertions: string[];
  assertionResults: VerificationAssertionItem[];
};

export function PlanVerificationPanel({
  info,
  language,
}: {
  info: PlanVerificationInfo;
  language: AppLanguage;
}) {
  const statusText = [
    info.status,
    info.verificationLevel ? `level: ${info.verificationLevel}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <section className={`plan-verification-panel ${info.failed ? 'failed' : ''}`}>
      <header>
        {info.failed ? <AlertCircle size={14} /> : <ShieldCheck size={14} />}
        <strong>
          {info.failed
            ? language === 'zh'
              ? '节点验证未通过'
              : 'Node verification failed'
            : language === 'zh'
              ? '节点验证'
              : 'Node verification'}
        </strong>
        {statusText && <em>{statusText}</em>}
      </header>
      {info.summary && <p>{info.summary}</p>}
      {info.assertionResults.length > 0 && (
        <ul>
          {info.assertionResults.map((item, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={`${item.label}-${index}`}>
              <span>{item.label}</span>
              {item.status && <em>{item.status}</em>}
              {item.summary && <small>{item.summary}</small>}
            </li>
          ))}
        </ul>
      )}
      {info.assertions.length > 0 && (
        <details className="plan-verification-assertions">
          <summary>
            {language === 'zh' ? '验收条件' : 'Success assertions'}
          </summary>
          <div>
            {info.assertions.map((item, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <code key={`${item}-${index}`}>{item}</code>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

export function planVerificationInfoFromExecution(
  execution: ChatToolExecution,
): PlanVerificationInfo | null {
  const facts = Array.isArray(execution.metadata.facts)
    ? execution.metadata.facts.map(asRecord)
    : [];
  const fact = facts.find((candidate) =>
    Array.isArray(candidate.categories) &&
    candidate.categories.includes('plan_verification'),
  );
  if (!fact) return null;
  const metadata = asRecord(fact.metadata);
  const status = nonEmptyString(fact.verification_state) ?? '';
  const summary = nonEmptyString(metadata.summary) ?? '';
  const verificationLevel = nonEmptyString(metadata.verificationLevel) ?? '';
  const assertions = Array.isArray(metadata.assertions)
    ? metadata.assertions.filter((item): item is string => typeof item === 'string')
    : [];
  const assertionResults = normalizeAssertionResults(metadata.assertionResults);
  const failed = fact.semantic_success === false || status === 'failed';
  return {
    failed,
    status,
    summary,
    verificationLevel,
    assertions,
    assertionResults,
  };
}

export function normalizeAssertionResults(value: unknown): VerificationAssertionItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) return null;
      const record = asRecord(item);
      const label = nonEmptyString(record.label) ?? '';
      const passed = typeof record.passed === 'boolean' ? record.passed : undefined;
      const summary = nonEmptyString(record.summary) ?? '';
      if (!label || passed === undefined) return null;
      return { label, status: passed ? 'passed' : 'failed', summary };
    })
    .filter((item): item is VerificationAssertionItem => item != null);
}

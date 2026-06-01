import { AlertCircle, ShieldCheck } from 'lucide-react';

import type { AppLanguage, ChatToolExecution } from '../types';
import {
  asRecord,
  firstDefined,
  firstRecord,
  nonEmptyString,
  parseToolOutputJson,
  stringArrayLoose,
} from './toolPayload';

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
  const outputPayload = parseToolOutputJson(execution.output);
  const payloads = [
    execution.metadata,
    asRecord(execution.metadata.result),
    asRecord(execution.metadata.plan),
    outputPayload,
    asRecord(outputPayload.result),
    asRecord(outputPayload.plan),
  ];
  const verificationResult = firstRecord(
    payloads.flatMap((payload) => [
      asRecord(payload.verification_result),
      asRecord(payload.verificationResult),
    ]),
  );
  const status =
    nonEmptyString(
      firstDefined(
        payloads.map((payload) =>
          payload.status ?? payload.verification_status ?? payload.verificationStatus,
        ),
      ),
    ) ??
    nonEmptyString(
      verificationResult.status ??
        verificationResult.verification_status ??
        verificationResult.verificationStatus,
    ) ??
    '';
  const summary =
    nonEmptyString(verificationResult.summary) ??
    nonEmptyString(verificationResult.message) ??
    nonEmptyString(
      firstDefined(payloads.map((payload) => payload.verification_summary)),
    ) ??
    '';
  const verificationLevel =
    nonEmptyString(
      firstDefined(
        payloads.map((payload) => payload.verification_level ?? payload.verificationLevel),
      ),
    ) ??
    nonEmptyString(verificationResult.verification_level ?? verificationResult.verificationLevel) ??
    '';
  const assertions = stringArrayLoose(
    firstDefined(
      payloads.map((payload) => payload.success_assertions ?? payload.successAssertions),
    ),
  );
  const assertionResults = normalizeAssertionResults(
    firstDefined([
      verificationResult.assertion_results,
      verificationResult.assertionResults,
      ...payloads.map((payload) => payload.assertion_results ?? payload.assertionResults),
    ]),
  );
  const failed =
    status.trim().toLowerCase() === 'verification_failed' ||
    assertionResults.some((item) => /fail|failed|false|missing/i.test(item.status));
  if (
    !failed &&
    !summary &&
    !verificationLevel &&
    assertions.length === 0 &&
    assertionResults.length === 0
  ) {
    return null;
  }
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
      if (item == null) {
        return null;
      }
      if (typeof item !== 'object' || Array.isArray(item)) {
        return {
          label: String(item),
          status: '',
          summary: '',
        };
      }
      const record = asRecord(item);
      const label =
        nonEmptyString(
          record.label ??
            record.name ??
            record.id ??
            record.assertion ??
            record.description,
        ) ?? '';
      const status =
        nonEmptyString(
          record.status ?? record.result ?? record.state ?? record.ok,
        ) ?? '';
      const summary =
        nonEmptyString(
          record.summary ?? record.message ?? record.detail ?? record.evidence,
        ) ?? '';
      if (!label && !status && !summary) {
        return null;
      }
      return { label: label || summary || status, status, summary };
    })
    .filter((item): item is VerificationAssertionItem => item != null);
}

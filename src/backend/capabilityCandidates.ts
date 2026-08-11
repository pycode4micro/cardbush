import type {
  CapabilityCandidate,
  CapabilityCandidatesUpdate,
} from '../types';

export function capabilityCandidatesFromPayload(
  value: unknown,
): CapabilityCandidatesUpdate {
  const payload = asRecord(value);
  return {
    protocol: String(payload.protocol ?? 'bush.capability_candidates.v1'),
    sessionId: String(payload.session_id ?? payload.sessionId ?? ''),
    turnId: String(payload.turn_id ?? payload.turnId ?? ''),
    authority: String(payload.authority ?? 'retrieval_evidence_only'),
    selection: String(payload.selection ?? 'model_decides'),
    skills: normalizeCandidates(payload.skills, 'skill'),
    tools: normalizeCandidates(payload.tools, 'tool'),
    timestamp: String(payload.timestamp ?? new Date().toISOString()),
    raw: payload,
  };
}

function normalizeCandidates(
  raw: unknown,
  type: CapabilityCandidate['type'],
): CapabilityCandidate[] {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => asRecord(item))
    .map((item) => {
      const rawMatchedFields = item.matched_fields ?? item.matchedFields;
      const matchedFields = Array.isArray(rawMatchedFields)
        ? rawMatchedFields
          .map((field: unknown) => String(field ?? '').trim())
          .filter(Boolean)
        : [];
      return {
        name: String(item.name ?? '').trim(),
        type,
        description: String(item.description ?? '').trim(),
        score: optionalNumber(item.score),
        path: String(item.path ?? '').trim() || undefined,
        matchedFields,
      };
    })
    .filter((item) => item.name);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

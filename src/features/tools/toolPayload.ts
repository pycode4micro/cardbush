export function parseToolOutputJson(value: string): Record<string, unknown> {
  const text = value.trim();
  if (!text.startsWith('{')) {
    return {};
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

export function nonEmptyString(value: unknown) {
  const text = value == null ? '' : String(value).trim();
  return text || undefined;
}

export function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
}

export function stringArrayLoose(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(summarizeLooseValue)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function summarizeLooseValue(value: unknown): string {
  if (value == null || value === '') {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(summarizeLooseValue).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const record = asRecord(value);
    const title = nonEmptyString(
      record.label ?? record.name ?? record.id ?? record.path ?? record.summary,
    );
    if (title) {
      return title;
    }
    return summarizeRecord(record);
  }
  return String(value).trim();
}

export function summarizeRecord(value: Record<string, unknown>) {
  const entries = Object.entries(value).filter(([, raw]) => raw != null && raw !== '');
  if (entries.length === 0) {
    return '-';
  }
  return entries
    .slice(0, 6)
    .map(([key, raw]) => `${key}: ${String(raw)}`)
    .join(' · ');
}

export function summarizeWriteScope(scope: string[]) {
  if (scope.length === 0) {
    return '';
  }
  const visible = scope.slice(0, 4).join(', ');
  return scope.length > 4 ? `${visible} +${scope.length - 4}` : visible;
}

export function firstDefined(values: unknown[]) {
  return values.find((value) => {
    if (value == null || value === '') {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (typeof value === 'object') {
      return Object.keys(asRecord(value)).length > 0;
    }
    return true;
  });
}

export function firstRecord(values: Record<string, unknown>[]) {
  return values.find((value) => Object.keys(value).length > 0) ?? {};
}

export function optionalBoolean(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === 'no') {
      return false;
    }
  }
  return undefined;
}

export function looseBoolean(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

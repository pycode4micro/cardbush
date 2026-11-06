/** A single, nonrecursive substitution pass. Callers own the output context's escaping. */
export function interpolateTemplate(source: string, pattern: RegExp, values: Record<string, unknown>, render: (value: unknown, kind: string) => string,
  identityFor: (kind: string, key: string) => string = (kind, key) => kind + ':' + key) {
  const used = new Set<string>();
  const output = source.replace(pattern, (_, kind: string, key: string) => {
    const identity = identityFor(kind, key);
    if (!Object.hasOwn(values, identity)) throw new Error(`Missing template variable: ${identity}`);
    used.add(identity);
    return render(values[identity], kind);
  });
  for (const key of Object.keys(values)) if (!used.has(key)) throw new Error(`Unexpected template variable: ${key}`);
  return output;
}

/** Repair invalid Unicode only in the outgoing JSON projection. Raw receipts and
 * session journals remain intact; valid text (including emoji) is unchanged.
 * Some providers reject lone UTF-16 surrogates even though JSON.stringify can
 * escape them, so resumed history needs this boundary as well as live output. */
export function wellFormedJson<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD') as T;
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let result: unknown[] = value;
    for (let index = 0; index < value.length; index++) {
      const next = wellFormedJson(value[index]);
      if (next !== value[index]) { if (result === value) result = [...value]; result[index] = next; }
    }
    return result as T;
  }
  let result = value;
  for (const [key, item] of Object.entries(value)) {
    const next = wellFormedJson(item);
    if (next !== item) { if (result === value) result = { ...value }; (result as Record<string, unknown>)[key] = next; }
  }
  return result;
}

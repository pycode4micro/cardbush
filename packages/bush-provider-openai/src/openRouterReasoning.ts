/** OpenRouter's reasoning sidecar is opaque; preserve stream order and signatures. */
export class OpenRouterReasoning {
  readonly details: Record<string, unknown>[] = [];
  #source?: 'text' | 'details';

  append(delta: { reasoning?: unknown; reasoning_content?: unknown; reasoning_details?: unknown }): string {
    const details = Array.isArray(delta.reasoning_details)
      ? delta.reasoning_details.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : [];
    this.details.push(...details.map(item => structuredClone(item)));
    const text = typeof delta.reasoning === 'string' ? delta.reasoning
      : typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
    // Gateways may send the same text in both fields. Choose one stream for UI;
    // encrypted data/signatures are only replayed, never rendered as thinking.
    const detailText = details.map(item => item.type === 'reasoning.text' && typeof item.text === 'string' ? item.text
      : item.type === 'reasoning.summary' && typeof item.summary === 'string' ? item.summary : '').join('');
    this.#source ??= text ? 'text' : detailText ? 'details' : undefined;
    return this.#source === 'text' ? text : detailText;
  }
}

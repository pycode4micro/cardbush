export class ResponseOutputIdentityError extends Error {
  readonly code = 'provider_output_identity_changed';
  constructor() { super('The provider reused an output item identity or position for different content.'); }
}

/** One index for text, reasoning and tools, shared by all stream reconcilers. */
export class ResponseOutputIndex {
  readonly #indices = new Map<string, number>();
  readonly #items = new Map<number, { id?: string; type: string }>();

  index(id: unknown): number | undefined { return typeof id === 'string' ? this.#indices.get(id) : undefined; }

  observe(index: number, id: unknown, type: string): void {
    if (!Number.isSafeInteger(index) || index < 0 || (id !== undefined && id !== null && typeof id !== 'string')) throw new ResponseOutputIdentityError();
    const identity = typeof id === 'string' && id ? id : undefined;
    const previous = this.#items.get(index), known = this.index(identity);
    if ((known !== undefined && known !== index) || (previous && (previous.type !== type || (previous.id && identity && previous.id !== identity)))) {
      throw new ResponseOutputIdentityError();
    }
    this.#items.set(index, { type, id: identity ?? previous?.id });
    if (identity) this.#indices.set(identity, index);
  }
}

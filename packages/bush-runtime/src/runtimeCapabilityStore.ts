import type { RuntimeCapabilityStore } from "./toolExecutionCoordinator.js";

export class InMemoryRuntimeCapabilityStore implements RuntimeCapabilityStore {
  readonly #sessions = new Map<string, Set<string>>();

  hasAll(sessionId: string, capabilityIds: string[]): boolean {
    const granted = this.#sessions.get(sessionId);
    return Boolean(
      granted && capabilityIds.length > 0 && capabilityIds.every((id) => granted.has(id)),
    );
  }

  grant(sessionId: string, capabilityIds: string[]): void {
    const granted = this.#sessions.get(sessionId) ?? new Set<string>();
    for (const id of capabilityIds) {
      const normalized = id.trim();
      if (!normalized) throw new Error("Capability identity cannot be empty.");
      granted.add(normalized);
    }
    this.#sessions.set(sessionId, granted);
  }

  clear(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}

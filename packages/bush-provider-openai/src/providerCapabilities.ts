import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type ProviderCapabilityStatus = "unknown" | "supported" | "unsupported";

export interface ProviderCapabilityObservation {
  status: ProviderCapabilityStatus;
  observedAt?: string;
  expiresAt?: string;
  reason?: string;
}

export interface ProviderCapabilityIdentity {
  scope: string;
  model: string;
  capability: string;
}

export interface ProviderCapabilityStore {
  read(identity: ProviderCapabilityIdentity): ProviderCapabilityObservation;
  observe(
    identity: ProviderCapabilityIdentity,
    observation: Omit<ProviderCapabilityObservation, "status"> & {
      status: "supported" | "unsupported";
    },
  ): void;
}

interface StoredObservation {
  status: "supported" | "unsupported";
  observedAt: string;
  expiresAt: string;
  reason?: string;
}

interface CapabilitySnapshot {
  protocol: "cardbush.provider_capabilities.v1";
  entries: Record<string, StoredObservation>;
}

export class InMemoryProviderCapabilityStore implements ProviderCapabilityStore {
  readonly #entries = new Map<string, StoredObservation>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = positiveTtl(options.ttlMs);
    this.#now = options.now ?? Date.now;
  }

  read(identity: ProviderCapabilityIdentity): ProviderCapabilityObservation {
    const key = capabilityKey(identity);
    const stored = this.#entries.get(key);
    if (!stored) return { status: "unknown" };
    if (Date.parse(stored.expiresAt) <= this.#now()) {
      this.#entries.delete(key);
      return { status: "unknown" };
    }
    return { ...stored };
  }

  observe(
    identity: ProviderCapabilityIdentity,
    observation: Omit<ProviderCapabilityObservation, "status"> & {
      status: "supported" | "unsupported";
    },
  ): void {
    const candidateObservedAt = observation.observedAt
      ? Date.parse(observation.observedAt)
      : this.#now();
    const observedAt = Number.isFinite(candidateObservedAt)
      ? candidateObservedAt
      : this.#now();
    this.#entries.set(capabilityKey(identity), {
      status: observation.status,
      observedAt: new Date(observedAt).toISOString(),
      expiresAt: observation.expiresAt ?? new Date(observedAt + this.#ttlMs).toISOString(),
      ...(observation.reason ? { reason: observation.reason } : {}),
    });
  }
}

export class FileProviderCapabilityStore implements ProviderCapabilityStore {
  readonly #path: string;
  readonly #memory: InMemoryProviderCapabilityStore;
  readonly #entries = new Map<string, StoredObservation>();

  constructor(
    path: string,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.#path = path;
    this.#memory = new InMemoryProviderCapabilityStore(options);
    this.#load();
  }

  read(identity: ProviderCapabilityIdentity): ProviderCapabilityObservation {
    const key = capabilityKey(identity);
    const stored = this.#entries.get(key);
    if (!stored) return { status: "unknown" };
    this.#memory.observe(identity, stored);
    const observation = this.#memory.read(identity);
    if (observation.status === "unknown") {
      this.#entries.delete(key);
      this.#persist();
    }
    return observation;
  }

  observe(
    identity: ProviderCapabilityIdentity,
    observation: Omit<ProviderCapabilityObservation, "status"> & {
      status: "supported" | "unsupported";
    },
  ): void {
    this.#memory.observe(identity, observation);
    const normalized = this.#memory.read(identity);
    if (normalized.status === "unknown" || !normalized.observedAt || !normalized.expiresAt) return;
    this.#entries.set(capabilityKey(identity), {
      status: normalized.status,
      observedAt: normalized.observedAt,
      expiresAt: normalized.expiresAt,
      ...(normalized.reason ? { reason: normalized.reason } : {}),
    });
    this.#persist();
  }

  #load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const snapshot = parsed as Partial<CapabilitySnapshot>;
    if (snapshot.protocol !== "cardbush.provider_capabilities.v1") return;
    if (!snapshot.entries || typeof snapshot.entries !== "object") return;
    for (const [key, candidate] of Object.entries(snapshot.entries)) {
      if (validStoredObservation(candidate)) this.#entries.set(key, candidate);
    }
  }

  #persist(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp-${process.pid}`;
    const snapshot: CapabilitySnapshot = {
      protocol: "cardbush.provider_capabilities.v1",
      entries: Object.fromEntries(this.#entries),
    };
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      renameSync(temporary, this.#path);
    } catch {
      rmSync(this.#path, { force: true });
      renameSync(temporary, this.#path);
    }
  }
}

export function openAIResponsesCapabilityScope(config: {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
}): string {
  const canonical = JSON.stringify({
    adapter: "openai_responses",
    credentialDigest: createHash("sha256").update(config.apiKey).digest("hex"),
    baseURL: config.baseURL ?? null,
    defaultHeaders: Object.fromEntries(
      Object.entries(config.defaultHeaders ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    timeoutMs: config.timeoutMs ?? null,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function capabilityKey(identity: ProviderCapabilityIdentity): string {
  return JSON.stringify([identity.scope, identity.model, identity.capability]);
}

function positiveTtl(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : 24 * 60 * 60 * 1_000;
}

function validStoredObservation(value: unknown): value is StoredObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredObservation>;
  return (candidate.status === "supported" || candidate.status === "unsupported") &&
    typeof candidate.observedAt === "string" && Number.isFinite(Date.parse(candidate.observedAt)) &&
    typeof candidate.expiresAt === "string" && Number.isFinite(Date.parse(candidate.expiresAt)) &&
    (candidate.reason === undefined || typeof candidate.reason === "string");
}

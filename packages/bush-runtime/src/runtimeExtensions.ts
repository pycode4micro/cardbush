import type { RuntimeCapabilities } from '@cardbush/bush-protocol';
import { settleAtAbort } from './abortSettlement.js';
import type { RuntimeConversation, RuntimeConversations } from './runtimeConversations.js';
import { validateEnvironmentSource, type EnvironmentSource, type RuntimeEnvironment } from './runtimeEnvironment.js';
import { runtimeExtensionOwner, type RuntimeExtension, type RuntimeExtensionApi, type RuntimeExtensionFactory } from './runtimeExtension.js';
import { ToolRegistry } from './toolRegistry.js';

export type RuntimeExtensionInstallOptions = { id?: string; enabled?: boolean; dataDirectory?: string; replace?: boolean };

type ExtensionEntry = { extension: RuntimeExtension; enabled: boolean; uses: number; retired?: boolean };
type ExtensionActivity = { count: number; idle: Promise<void>; resolve(): void };
type ExtensionApi = Omit<RuntimeExtensionApi, 'tools' | 'dataDirectory' | 'environment' | 'conversations'> & {
  environment: Pick<RuntimeExtensionApi['environment'], 'read'>;
  wait: RuntimeExtensionApi['conversations']['wait'];
};

/** Owns installed extension generations and drains retired generations before package removal. */
export class RuntimeExtensions {
  readonly #entries = new Map<string, ExtensionEntry>();
  readonly #activity = new Map<string, ExtensionActivity>();

  constructor(private readonly host: {
    api: ExtensionApi;
    tools: ToolRegistry;
    environment: RuntimeEnvironment;
    conversations: RuntimeConversations;
    baseCapabilities: RuntimeCapabilities;
    onError?: (error: Error) => void;
  }) {}

  /** Stage registrations so an invalid candidate cannot replace the live generation. */
  install(create: RuntimeExtensionFactory, options: RuntimeExtensionInstallOptions = {}): string {
    const tools = new ToolRegistry();
    const sources = new Map<string, EnvironmentSource>();
    const { api, conversations } = this.host;
    const { wait, ...extensionApi } = api;
    let entry: ExtensionEntry | undefined;
    const extension = create({
      ...extensionApi, tools, dataDirectory: options.dataDirectory,
      environment: { read: api.environment.read, register: (name, source) => {
        validateEnvironmentSource(name, source);
        if (sources.has(name) || sources.size >= 16) throw new Error('Duplicate environment source or plugin source limit reached.');
        const read: EnvironmentSource = context => {
          if (entry && this.#isCurrent(entry)) return this.#use(entry, () => source(context));
        };
        sources.set(name, read);
        return () => { if (sources.get(name) === read) sources.delete(name); };
      } },
      conversations: {
        list: () => conversations.list(), wait,
        notify: (id, notice) => entry && this.#isCurrent(entry)
          ? conversations.notify(id, { ...notice, key: `${entry.extension.id}:${notice.key}` }) : false,
        dismiss: (id, key) => {
          if (entry && this.#isCurrent(entry)) conversations.dismiss(id, `${entry.extension.id}:${key}`);
        },
      },
    });
    try {
      const prior = this.#validate(extension, options);
      const owner = runtimeExtensionOwner(extension.id);
      const next: ExtensionEntry = { extension, enabled: options.enabled === true, uses: 0 };
      this.host.tools.replaceOwned(owner, tools.catalog().map(item => {
        const registration = tools.resolve(item.definition.name)!;
        return { ...registration,
          execute: context => this.#use(next, () => registration.execute(context)),
          ...(registration.authorize ? { authorize: context => this.#use(next, () => registration.authorize!(context)) } : {}),
        };
      }));
      this.host.environment.replaceOwned(extension.id, sources, next.enabled);
      entry = next;
      this.#entries.set(extension.id, next);
      this.host.tools.setOwnerEnabled(owner, next.enabled);
      if (prior) {
        conversations.revoke(`${extension.id}:`);
        this.#retire(prior);
      }
      if (next.enabled) this.#refreshConversationContext(next);
      return extension.id;
    } catch (error) {
      try { void Promise.resolve(extension?.dispose?.()).catch(() => {}); }
      catch { /* Preserve the admission error. */ }
      throw error;
    }
  }

  #validate(extension: RuntimeExtension, options: RuntimeExtensionInstallOptions) {
    if (!extension || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(extension.id) || (options.id && extension.id !== options.id)) {
      throw new Error('Runtime extension identity is empty, invalid, or does not match its package.');
    }
    if (!Array.isArray(extension.features) || extension.features.some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('Invalid Runtime extension features.');
    }
    if (!extension.commands || typeof extension.commands !== 'object') throw new Error('Invalid Runtime extension commands.');
    const prior = this.#entries.get(extension.id);
    if (prior && !options.replace) throw new Error(`Duplicate Runtime extension ${extension.id}.`);
    const commands = new Set(this.host.baseCapabilities.supportedCommands);
    for (const { extension: installed } of this.#entries.values()) {
      if (installed.id !== extension.id) for (const command of Object.keys(installed.commands)) commands.add(command);
    }
    for (const [command, handler] of Object.entries(extension.commands)) {
      if (!command.trim() || commands.has(command) || typeof handler !== 'function') {
        throw new Error(`Runtime extension command conflicts with an existing command: ${command}`);
      }
    }
    return prior;
  }

  setEnabled(id: string, enabled: boolean): void {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`Runtime extension ${id} is not available in this host.`);
    const wasEnabled = entry.enabled;
    entry.enabled = enabled;
    if (!enabled) this.host.conversations.revoke(`${id}:`);
    this.host.environment.setOwnerEnabled(id, enabled);
    this.host.tools.setOwnerEnabled(runtimeExtensionOwner(id), enabled);
    if (enabled && !wasEnabled) this.#refreshConversationContext(entry);
  }

  remove(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.setEnabled(id, false);
    this.host.tools.removeOwned(runtimeExtensionOwner(id));
    this.#entries.delete(id);
    this.host.environment.removeOwned(id);
    this.#retire(entry);
  }

  close(): void {
    for (const id of this.#entries.keys()) this.remove(id);
  }

  capabilities(): RuntimeCapabilities {
    const result = structuredClone(this.host.baseCapabilities);
    for (const { extension, enabled } of this.#entries.values()) if (enabled) {
      result.features.push(...extension.features);
      result.supportedCommands.push(...Object.keys(extension.commands));
    }
    return result;
  }

  #commandOwner(kind: string): ExtensionEntry | undefined {
    for (const entry of this.#entries.values()) if (Object.hasOwn(entry.extension.commands, kind)) return entry;
  }

  hasCommand(kind: string): boolean { return !!this.#commandOwner(kind); }

  dispatch(kind: string, payload: unknown, signal?: AbortSignal): Promise<unknown> | undefined {
    const entry = this.#commandOwner(kind);
    const handler = entry?.extension.commands[kind];
    if (!entry || !handler) return;
    if (!entry.enabled) throw new Error(`Runtime extension ${entry.extension.id} is not enabled.`);
    return this.#use(entry, () => handler(payload, signal));
  }

  async beginConversation(conversation: RuntimeConversation): Promise<void> {
    for (const entry of this.#entries.values()) if (entry.enabled && entry.extension.conversationContext) {
      try { await this.#loadConversationContext(entry, conversation); }
      catch (error) { this.#report(error); }
    }
    await this.conversationChanged(conversation);
  }

  async conversationChanged(conversation: RuntimeConversation): Promise<void> {
    for (const entry of this.#entries.values()) if (entry.enabled && entry.extension.conversationChanged) {
      try { await this.#use(entry, () => entry.extension.conversationChanged!(conversation)); }
      catch (error) { this.#report(error); }
    }
  }

  #refreshConversationContext(entry: ExtensionEntry): void {
    if (!entry.extension.conversationContext) return;
    // Hot loading presents context at the next normal model boundary.
    void (async () => {
      for (const conversation of this.host.conversations.list()) {
        if (conversation.status === 'running' && this.#isCurrent(entry)) await this.#loadConversationContext(entry, conversation);
      }
    })().catch(error => this.#report(error));
  }

  async #loadConversationContext(entry: ExtensionEntry, conversation: RuntimeConversation): Promise<void> {
    const context = await this.#use(entry, () => entry.extension.conversationContext!(conversation));
    if (this.#isCurrent(entry)) context.forEach((message, index) => this.host.conversations.notify(conversation.agentId, {
      key: `${entry.extension.id}:catalog:${index}`, content: message.content,
    }));
  }

  #isCurrent(entry: ExtensionEntry): boolean {
    return entry.enabled && !entry.retired && this.#entries.get(entry.extension.id) === entry;
  }

  #report(error: unknown): void { this.host.onError?.(error instanceof Error ? error : new Error(String(error))); }

  get busy(): boolean { return this.#activity.size > 0; }

  isBusy(id: string): boolean { return this.#activity.has(id); }

  async waitForIdle(id: string, signal?: AbortSignal): Promise<void> {
    let active: ExtensionActivity | undefined;
    while ((active = this.#activity.get(id))) {
      await settleAtAbort(active.idle, signal, 'Plugin update cancelled.');
      signal?.throwIfAborted();
    }
  }

  #beginActivity(id: string): () => void {
    let activity = this.#activity.get(id);
    if (!activity) {
      let resolve!: () => void;
      const idle = new Promise<void>(finish => { resolve = finish; });
      activity = { count: 0, idle, resolve };
      this.#activity.set(id, activity);
    }
    const current = activity;
    current.count++;
    return () => {
      if (--current.count > 0) return;
      this.#activity.delete(id);
      current.resolve();
    };
  }

  async #use<T>(entry: ExtensionEntry, operation: () => T | Promise<T>): Promise<T> {
    if (entry.retired) throw Object.assign(new Error('Plugin was updated before this call started. Use the current tool definition.'),
      { code: 'tool_definition_changed', details: { inputDispatched: false } });
    entry.uses++;
    const finish = this.#beginActivity(entry.extension.id);
    try { return await operation(); }
    finally {
      if (--entry.uses === 0 && entry.retired) this.#dispose(entry.extension);
      finish();
    }
  }

  #retire(entry: ExtensionEntry): void {
    entry.retired = true;
    if (!entry.uses) this.#dispose(entry.extension);
  }

  #dispose(extension: RuntimeExtension): void {
    // Acquire the cleanup lease before releasing the last call's lease.
    const finish = this.#beginActivity(extension.id);
    try {
      const cleanup = extension.dispose?.();
      if (cleanup) void Promise.resolve(cleanup).catch(error => console.warn('Extension cleanup failed', error)).finally(finish);
      else finish();
    } catch (error) {
      console.warn('Extension cleanup failed', error);
      finish();
    }
  }
}

import { setTimeout as pause } from 'node:timers/promises';
import { AgentHttpClient } from './agentHttpClient.mjs';
import type { AgentEventFrame, AgentEventRequest, AgentOperation } from './agentTypes.js';
import { imageToken, modelToken, tenantKey, WebError, type WebModel } from './webCommon.mjs';

export interface WebAgent {
  call(operation: AgentOperation, input: Record<string, unknown>): Promise<unknown>;
  events(input: AgentEventRequest, signal: AbortSignal): AsyncIterable<AgentEventFrame>;
}
export interface WebAgents { get(userId: string): Promise<WebAgent>; close(): void }
export class BrokerWebAgents implements WebAgents {
  readonly #opening = new Map<string, Promise<WebAgent>>();
  readonly #clients = new Map<string, { client: AgentHttpClient; containerId: string; configuredAt: number }>();
  constructor(readonly config: { brokerURL: string; brokerSecret: string; modelSecret: string; internalURL: string; models: WebModel[]; defaultModelId: string }, readonly imageAllowed: (userId: string) => Promise<boolean>) {}
  get(userId: string) {
    const pending = this.#opening.get(userId); if (pending) return pending;
    const opening = this.#open(userId).finally(() => this.#opening.delete(userId));
    this.#opening.set(userId, opening); return opening;
  }
  async #open(userId: string): Promise<WebAgent> {
    const response = await fetch(new URL('/ensure', this.config.brokerURL), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.brokerSecret}` }, body: JSON.stringify({ key: tenantKey(userId) }) });
    const result = await response.json() as { url: string; token: string; containerId: string; error?: string };
    if (!response.ok) throw new WebError(503, result.error ?? '会话服务暂不可用。');
    const previous = this.#clients.get(userId);
    const client = previous?.containerId === result.containerId ? previous.client : new AgentHttpClient(result.url, result.token);
    if (previous && previous.client !== client) previous.client.close();
    let ready = false;
    for (let attempt = 0; attempt < 35; attempt++) {
      try { const info = await client.info(); if (info.capabilities.webRestricted !== true) throw new WebError(503, '个人目录和工具权限策略尚未生效。'); ready = true; break; }
      catch (error) { if (error instanceof WebError) { client.close(); throw error; } if (attempt === 34) break; await pause(750); }
    }
    if (!ready) { client.close(); this.#clients.delete(userId); throw new WebError(503, '会话服务启动失败，请稍后重试。'); }
    // Service restarts and administrator configuration changes are reconciled
    // before a user can submit a turn. Vendor credentials stay in the gateway.
    if (!previous || previous.client !== client || Date.now() - previous.configuredAt > 60_000) {
      await client.call('product.command', { kind: 'models.update', config: { defaultModelId: this.config.defaultModelId,
        models: this.config.models.map(model => ({ id: model.id, name: model.name, provider: 'openai', model: model.model,
          apiProtocol: model.apiProtocol ?? 'openai_responses', apiKey: modelToken(this.config.modelSecret, userId),
          baseURL: `${this.config.internalURL.replace(/\/$/, '')}/internal/model/${encodeURIComponent(userId)}/${encodeURIComponent(model.id)}`,
          ...(model.maxContextTokens ? { maxContextTokens: model.maxContextTokens } : {}), ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}) })) } });
      this.#clients.set(userId, { client, containerId: result.containerId, configuredAt: Date.now() });
    }
    await client.call('web.configure', { imageEnabled: await this.imageAllowed(userId), gateway: `${this.config.internalURL.replace(/\/$/, '')}/internal/image/${encodeURIComponent(userId)}/images/generations`, credential: imageToken(this.config.modelSecret, userId) });
    return client;
  }
  close() { for (const value of this.#clients.values()) value.client.close(); this.#clients.clear(); }
}

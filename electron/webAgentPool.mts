import { waitForWebAgent, WEB_AGENT_STARTUP_MS, WebAgentStartupError } from './webAgentStartup.mjs';
import { createHash } from 'node:crypto';
import { AgentHttpClient } from './agentHttpClient.mjs';
import type { AgentEventFrame, AgentEventRequest, AgentOperation } from './agentTypes.js';
import { imageToken, modelToken, tenantKey, WebError, type WebModel } from './webCommon.mjs';
import { remoteAgentToken } from './webRemoteAgents.mjs';

export interface WebAgent {
  historyPaging?: boolean;
  call(operation: AgentOperation, input: Record<string, unknown>): Promise<unknown>;
  events(input: AgentEventRequest, signal: AbortSignal): AsyncIterable<AgentEventFrame>;
}
export interface WebAgents { get(userId: string): Promise<WebAgent>; close(): void }
export class BrokerWebAgents implements WebAgents {
  readonly #opening = new Map<string, Promise<WebAgent>>();
  readonly #clients = new Map<string, { client: AgentHttpClient; containerId: string; configuredAt: number; modelFingerprint: string }>();
  constructor(readonly config: { brokerURL: string; brokerSecret: string; modelSecret: string; internalURL: string; models: WebModel[]; defaultModelId: string }, readonly imageAllowed: (userId: string) => Promise<boolean>) {}
  get(userId: string) {
    const pending = this.#opening.get(userId); if (pending) return pending;
    const opening = this.#open(userId).catch(error => {
      if (error instanceof WebError) throw error;
      this.#clients.get(userId)?.client.close(); this.#clients.delete(userId);
      throw new WebError(503, error instanceof Error && error.name === 'TimeoutError' ? 'SESSION_AGENT_START_TIMEOUT' : 'SESSION_AGENT_START_FAILED');
    }).finally(() => this.#opening.delete(userId));
    this.#opening.set(userId, opening); return opening;
  }
  async #open(userId: string): Promise<WebAgent> {
    const deadline = AbortSignal.timeout(WEB_AGENT_STARTUP_MS);
    const response = await fetch(new URL('/ensure', this.config.brokerURL), { method: 'POST', redirect: 'error', signal: deadline,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.brokerSecret}` }, body: JSON.stringify({ key: tenantKey(userId) }) });
    const result = await response.json() as { url: string; token: string; containerId: string; error?: string };
    if (!response.ok) throw new WebError(503, result.error ?? '会话服务暂不可用。');
    const previous = this.#clients.get(userId);
    const client = previous?.containerId === result.containerId ? previous.client : AgentHttpClient.forIsolatedContainer(result.url, result.token);
    if (previous && previous.client !== client) previous.client.close();
    let info;
    try {
      info = await waitForWebAgent(client, deadline, async signal => {
        const response = await fetch(new URL(`/status?key=${tenantKey(userId)}`, this.config.brokerURL), {
          headers: { Authorization: `Bearer ${this.config.brokerSecret}` }, signal,
        });
        return response.ok ? response.json() as Promise<{ state?: string; code?: string }> : {};
      });
    } catch (error) {
      client.close(); this.#clients.delete(userId);
      throw new WebError(503, error instanceof WebAgentStartupError ? error.code : 'SESSION_AGENT_START_FAILED');
    }
    // Service restarts and administrator configuration changes are reconciled
    // before a user can submit a turn. Vendor credentials stay in the gateway.
    const currentModels = { defaultModelId: this.config.defaultModelId, models: this.config.models };
    const modelFingerprint = createHash('sha256').update(JSON.stringify(currentModels)).digest('hex');
    if (!previous || previous.client !== client || previous.modelFingerprint !== modelFingerprint || Date.now() - previous.configuredAt > 60_000) {
      await client.call('product.command', { kind: 'models.update', config: { defaultModelId: currentModels.defaultModelId,
        models: currentModels.models.map(model => ({ id: model.id, name: model.name, provider: model.apiProtocol === 'anthropic_messages' ? 'anthropic' : 'openai', model: model.model,
          apiProtocol: model.apiProtocol ?? 'openai_responses', apiKey: modelToken(this.config.modelSecret, userId),
          baseURL: `${this.config.internalURL.replace(/\/$/, '')}/internal/model/${encodeURIComponent(userId)}/${encodeURIComponent(model.id)}`,
          ...(model.maxContextTokens ? { maxContextTokens: model.maxContextTokens } : {}),
          maxOutputTokens: model.maxOutputTokens ?? 128_000,
          reasoningEffort: model.reasoningEffort === undefined ? 'medium' : model.reasoningEffort })) } }, deadline);
      this.#clients.set(userId, { client, containerId: result.containerId, configuredAt: Date.now(), modelFingerprint });
    }
    await client.call('web.configure', { imageEnabled: await this.imageAllowed(userId), gateway: `${this.config.internalURL.replace(/\/$/, '')}/internal/image/${encodeURIComponent(userId)}/images/generations`, credential: imageToken(this.config.modelSecret, userId),
      remoteAgents: { gateway: `${this.config.internalURL.replace(/\/$/, '')}/internal/remote-agents/${encodeURIComponent(userId)}`, credential: remoteAgentToken(this.config.modelSecret, userId) } }, deadline);
    return Object.assign(client, { historyPaging: info.capabilities.sessionHistoryPaging === true });
  }
  close() { for (const value of this.#clients.values()) value.client.close(); this.#clients.clear(); }
}

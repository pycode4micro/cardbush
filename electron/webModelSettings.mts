import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { WebError, type WebModel } from './webCommon.mjs';

type ManagedModel = WebModel & { enabled: boolean };
type ImageModel = { model: string; baseURL: string; apiKey: string };
type Settings = { defaultModelId: string; models: ManagedModel[]; imageModel?: ImageModel };
export type ModelTarget = { modelSecret: string; defaultModelId: string; models: WebModel[]; imageModel?: ImageModel };
type Row = { revision: number; payload: string };
export interface ModelSettingsRepository {
  initialize(payload: string): Promise<void>;
  read(): Promise<Row>;
  replace(revision: number, payload: string): Promise<Row | null>;
}

/** Credentials are encrypted with the gateway secret, never copied into tenant settings. */
export class PostgresModelSettingsRepository implements ModelSettingsRepository {
  constructor(readonly pool: Pool) {}
  async initialize(payload: string) {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS cardbush_web_model_settings (
      id integer PRIMARY KEY CHECK (id=1), revision integer NOT NULL, payload text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now());`);
    await this.pool.query('INSERT INTO cardbush_web_model_settings(id,revision,payload) VALUES(1,1,$1) ON CONFLICT DO NOTHING', [payload]);
  }
  async read(): Promise<Row> {
    const row = (await this.pool.query('SELECT revision,payload FROM cardbush_web_model_settings WHERE id=1')).rows[0];
    if (!row) throw new Error('Model settings are missing.');
    return row;
  }
  async replace(revision: number, payload: string): Promise<Row | null> {
    return (await this.pool.query('UPDATE cardbush_web_model_settings SET revision=revision+1,payload=$2,updated_at=now() WHERE id=1 AND revision=$1 RETURNING revision,payload', [revision, payload])).rows[0] ?? null;
  }
}

const endpoint = z.string().trim().max(2048).url().refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, 'API 地址只允许 HTTP/HTTPS，不可包含账号、查询参数或片段。');
const modelInput = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(120), model: z.string().trim().min(1).max(160),
  baseURL: endpoint, apiKey: z.string().trim().max(8192).optional(),
  apiProtocol: z.enum(['openai_responses', 'openai_chat_completions', 'anthropic_messages']),
  enabled: z.boolean(), maxContextTokens: z.number().int().min(2048).max(2_000_000),
  maxOutputTokens: z.number().int().min(1).max(1_000_000),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).nullable(),
}).strict();
const revisionInput = z.number().int().positive();
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), revision: revisionInput, model: modelInput }).strict(),
  z.object({ action: z.literal('delete'), revision: revisionInput, id: z.string().max(80) }).strict(),
  z.object({ action: z.literal('default'), revision: revisionInput, id: z.string().max(80) }).strict(),
  z.object({ action: z.literal('image'), revision: revisionInput, model: z.string().trim().min(1).max(160), apiKey: z.string().trim().max(8192).optional() }).strict(),
]);

export class WebModelSettings {
  #revision = 0;
  #settings!: Settings;
  #loadedAt = 0;
  #loading?: Promise<void>;
  readonly #key: Buffer;
  constructor(readonly target: ModelTarget, readonly repository: ModelSettingsRepository) {
    this.#key = createHash('sha256').update('cardbush-web-model-settings-v1\0').update(target.modelSecret).digest();
  }
  #encrypt(settings: Settings) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from('cardbush-web-model-settings-v1'));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(settings), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), bytes.toString('base64')].join('.');
  }
  #apply(row: Row) {
    if (row.revision < this.#revision) return;
    const [version, iv, tag, payload] = row.payload.split('.');
    if (version !== 'v1') throw new Error('Unsupported model settings format.');
    const cipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv!, 'base64'));
    cipher.setAAD(Buffer.from('cardbush-web-model-settings-v1'));
    cipher.setAuthTag(Buffer.from(tag!, 'base64'));
    const settings: Settings = JSON.parse(Buffer.concat([cipher.update(Buffer.from(payload!, 'base64')), cipher.final()]).toString('utf8'));
    this.#validate(settings);
    this.#settings = settings; this.#revision = row.revision;
    this.target.defaultModelId = settings.defaultModelId;
    this.target.models = settings.models.filter(model => model.enabled).map(({ enabled: _, ...model }) => model);
    this.target.imageModel = settings.imageModel;
    this.#loadedAt = Date.now();
  }
  #validate(settings: Settings) {
    if (!settings.models.some(model => model.enabled && model.id === settings.defaultModelId)) throw new WebError(400, '默认模型必须保持启用，请先设置其他默认模型。');
    if (new Set(settings.models.map(model => model.id)).size !== settings.models.length || settings.models.length > 50) throw new WebError(400, '模型标识不可重复，最多配置 50 个模型。');
    for (const model of settings.models) {
      if (!model.apiKey) throw new WebError(400, '请填写 API 密钥。');
      if ((model.maxOutputTokens ?? 128000) >= (model.maxContextTokens ?? 400000)) throw new WebError(400, '最大输出必须小于上下文窗口。');
    }
  }
  async initialize() {
    const initial: Settings = { defaultModelId: this.target.defaultModelId,
      models: this.target.models.map(model => ({ ...model, enabled: true, apiProtocol: model.apiProtocol ?? 'openai_responses',
        maxContextTokens: model.maxContextTokens ?? 400000, maxOutputTokens: model.maxOutputTokens ?? 128000,
        reasoningEffort: model.reasoningEffort === undefined ? 'medium' : model.reasoningEffort })),
      ...(this.target.imageModel ? { imageModel: this.target.imageModel } : {}) };
    this.#validate(initial);
    await this.repository.initialize(this.#encrypt(initial));
    await this.refresh(true);
  }
  async refresh(force = false) {
    if (!force && Date.now() - this.#loadedAt < 2000) return;
    if (this.#loading) return this.#loading;
    this.#loading = this.repository.read().then(row => this.#apply(row)).finally(() => { this.#loading = undefined; });
    return this.#loading;
  }
  view() {
    return { revision: this.#revision, defaultModelId: this.#settings.defaultModelId,
      models: this.#settings.models.map(({ apiKey, ...model }) => ({ ...model, hasApiKey: Boolean(apiKey) })),
      imageModel: this.#settings.imageModel ? { model: this.#settings.imageModel.model, hasApiKey: Boolean(this.#settings.imageModel.apiKey) } : null };
  }
  async update(input: unknown) {
    const change = command.parse(input);
    await this.refresh(true);
    if (change.revision !== this.#revision) throw new WebError(409, '模型配置已被修改，请刷新列表后重试。');
    const next = structuredClone(this.#settings);
    if (change.action === 'save') {
      const index = next.models.findIndex(model => model.id === change.model.id), previous = next.models[index];
      if (previous && new URL(previous.baseURL).origin !== new URL(change.model.baseURL).origin && !change.model.apiKey) throw new WebError(400, '更换 API 域名时请重新填写密钥。');
      const model = { ...change.model, apiKey: change.model.apiKey || previous?.apiKey || '' };
      if (index < 0) next.models.push(model); else next.models[index] = model;
    } else if (change.action === 'delete') {
      if (!next.models.some(model => model.id === change.id)) throw new WebError(404, '模型不存在。');
      next.models = next.models.filter(model => model.id !== change.id);
    } else if (change.action === 'default') next.defaultModelId = change.id;
    else {
      const apiKey = change.apiKey || next.imageModel?.apiKey;
      if (!apiKey) throw new WebError(400, '请填写生图 API 密钥。');
      next.imageModel = { model: change.model, apiKey, baseURL: 'https://ark.cn-beijing.volces.com/api/v3' };
    }
    this.#validate(next);
    const row = await this.repository.replace(change.revision, this.#encrypt(next));
    if (!row) { await this.refresh(true); throw new WebError(409, '模型配置已被修改，请刷新列表后重试。'); }
    this.#apply(row);
    return this.view();
  }
}

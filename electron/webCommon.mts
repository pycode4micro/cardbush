import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class WebError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const tenantKey = (userId: string) => digest(`cardbush-web-tenant:${userId}`);
export const tenantToken = (secret: string, key: string) => createHmac('sha256', secret).update(`agent:${key}`).digest('hex');
export const imageToken = (secret: string, userId: string) => createHmac('sha256', secret).update(`image:${userId}`).digest('hex');
export const modelToken = (secret: string, userId: string) => createHmac('sha256', secret).update(`model:${userId}`).digest('hex');
export function equalSecret(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}
export async function readJson(request: IncomingMessage, max = 1024 * 1024): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new WebError(415, '请使用 JSON 请求。');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) throw new WebError(413, '内容过长。');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new WebError(400, '请求格式不正确。'); }
}
export function cookie(request: IncomingMessage) {
  const value = (request.headers.cookie ?? '').split(';').map(item => item.trim()).find(item => item.startsWith('cardbush_web='))?.slice(13) ?? '';
  return /^[A-Za-z0-9_-]{40,100}$/.test(value) ? value : '';
}
export const csrfToken = (token: string) => digest(`cardbush-web-csrf:${token}`);
export type WebUser = { id: string; username: string; display_name: string; role: string; is_active: boolean; department_id: string | null; department_name?: string | null; company_id?: string | null; company_name?: string | null; deleted_at?: string | null };
export type WebCompany = { id: string; name: string; description: string; department_count: number; member_count: number };
export type WebDepartment = { id: string; name: string; description: string | null; company_id: string; company_name: string; is_active: boolean; member_count: number };
export type WebConversation = { id: string; title: string; pinned: boolean; archived: boolean; created_at: string; updated_at: string };
export type WebModel = { id: string; name: string; model: string; baseURL: string; apiKey: string; apiProtocol?: 'openai_responses' | 'openai_chat_completions' | 'anthropic_messages'; maxContextTokens?: number; maxOutputTokens?: number };

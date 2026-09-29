import type { ModelApiProtocol } from '@cardbush/bush-protocol';

export const modelProtocols: { value: ModelApiProtocol; label: string; path: string; baseUrl: string }[] = [
  { value: 'openai_responses', label: 'OpenAI Responses', path: '/responses', baseUrl: 'https://api.openai.com/v1' },
  { value: 'openai_chat_completions', label: 'OpenAI Chat Completions', path: '/chat/completions', baseUrl: 'https://api.openai.com/v1' },
  { value: 'anthropic_messages', label: 'Anthropic Messages', path: '/messages', baseUrl: 'https://api.anthropic.com/v1' },
];
export type ModelDiscoveryOptions = { apiProtocol: ModelApiProtocol; defaultHeaders: Record<string, string> };
export type DiscoverModels = (baseUrl: string, apiKey: string, options: ModelDiscoveryOptions) => Promise<{ models: string[] }>;

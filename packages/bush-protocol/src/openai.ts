// Experimental native account/connector protocol, verified against OpenAI's public client.
// Keep registration and service coordinates together so future public registration can replace them.
export const OPENAI_HOSTED_PROTOCOL = Object.freeze({
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  mcpEndpoint: 'https://chatgpt.com/backend-api/ps/mcp',
  scopes: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
});

/** Explicit user connections take precedence over the default hosted registration. */
export function usesOpenAiHostedConnection(registeredAppId: unknown, settings: Record<string, unknown>): boolean {
  if (typeof registeredAppId !== 'string' || !registeredAppId || settings.server) return false;
  if (settings.provider === 'openai') return true;
  if (settings.provider === 'direct') return false;
  const connection = settings.connection as Record<string, unknown> | undefined;
  const oauth = settings.oauth as Record<string, unknown> | undefined;
  const configured = (value: Record<string, unknown> | undefined) => Object.values(value ?? {}).some(item => item !== undefined && item !== null);
  return !configured(connection) && !configured(oauth);
}

export type OpenAiAccountStatus = {
  state: 'signed_out' | 'signing_in' | 'signed_in' | 'reauth_required' | 'unavailable';
  experimental: true;
  lastError?: string;
};
export type OpenAiAccess = { accessToken: string; accountId?: string; generation?: number };

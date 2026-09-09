// Experimental native account/connector protocol, verified against OpenAI's public client.
// Keep registration and service coordinates together so future public registration can replace them.
export const OPENAI_HOSTED_PROTOCOL = Object.freeze({
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  mcpEndpoint: 'https://chatgpt.com/backend-api/ps/mcp',
  appsEndpoint: 'https://chatgpt.com/apps',
  scopes: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
});

/** OpenAI's app page starts the provider's authorization flow; no credentials enter this URL. */
export function openAiAppAuthorizationUrl(name: string, registeredAppId: unknown): string | undefined {
  if (typeof registeredAppId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(registeredAppId)) return undefined;
  // Same app-name slug convention as the public client's connector directory.
  const slug = Array.from(name, character => /^[A-Za-z0-9]$/.test(character) ? character.toLowerCase() : '-').join('').replace(/^-+|-+$/g, '') || 'app';
  return `${OPENAI_HOSTED_PROTOCOL.appsEndpoint}/${slug}/${registeredAppId}`;
}

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

import type { ResponseCreateParamsStreaming, ResponseInputItem } from 'openai/resources/responses/responses';
import { SIWC, type ModelEvent } from '@cardbush/bush-protocol';

export type ChatGptAccess = (accountId: string, input: { rejectedToken?: string; signal?: AbortSignal }) => Promise<string>;

/** Quota exhaustion needs user action; a temporary usage lookup failure can back off. */
export function siwcFailure(failure: Extract<ModelEvent, { kind: 'response_failed' }>): typeof failure {
  if (failure.code === 'subscription_sharing_usage_limit_exceeded') return { ...failure, retryable: false };
  if (['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'].includes(failure.code)) {
    return { ...failure, retryable: true };
  }
  return failure;
}

/** SIWC uses the same Responses decoder and local tools, with an explicit wire contract. */
export function siwcResponsesParams(params: ResponseCreateParamsStreaming): ResponseCreateParamsStreaming {
  const { previous_response_id: _previous, max_output_tokens: _max, temperature: _temperature, top_p: _topP, tools, ...rest } = params;
  const input = (Array.isArray(params.input) ? params.input : []).map(item =>
    item.type === 'message' && item.role === 'system' ? { ...item, role: 'developer' as const } : item);
  // Additional tool declarations preserve existing function names and replay IDs.
  // Unlike tool_search, they are supported by the plan-backed Responses endpoint.
  if (tools?.length) input.unshift({ type: 'additional_tools', role: 'developer', tools } as ResponseInputItem);
  return { ...rest, input, store: false, stream: true };
}

/** Credentials are requested per HTTP exchange and never enter model requests/checkpoints. */
export function siwcFetch(accountId: string, access: ChatGptAccess, transport: typeof fetch = fetch, lifetime?: AbortSignal): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href !== `${SIWC.resource}/responses` || init?.method !== 'POST') throw new Error('ChatGPT inference requires the public Responses API.');
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), ...(lifetime ? [lifetime] : [])]);
    let token: string;
    try { token = await access(accountId, { signal }); }
    catch (error) { signal.throwIfAborted(); return authFailure(error); }
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${token}`);
      const response = await transport(input, { ...init, headers, signal, redirect: 'error' });
      if (response.status === 401 && !attempt) {
        await response.body?.cancel();
        try { token = await access(accountId, { rejectedToken: token, signal }); }
        catch (error) { signal.throwIfAborted(); return authFailure(error); }
        continue;
      }
      return response;
    }
    return authFailure();
  };
}
function authFailure(error?: unknown) {
  if ((error as { code?: string } | undefined)?.code === 'siwc_unavailable') return Response.json({ error: {
    code: 'chatgpt_auth_unavailable', message: 'ChatGPT authorization is temporarily unavailable. Check the network and secure storage, then retry.',
  } }, { status: 503 });
  return Response.json({ error: { code: 'chatgpt_auth_required', message: 'ChatGPT authorization is unavailable or expired. Continue with ChatGPT in model settings and enable plan access.' } }, { status: 401 });
}

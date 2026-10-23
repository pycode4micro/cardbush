// Loaded only by isolated CLI integration tests, including their Runtime worker.
// Replace the network boundary, retaining model binding, IPC auth and tool execution.
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { ProxyFetchPool } from '../../dist-electron/proxyFetch.mjs';

const mode = process.env.CB_TEST_MODEL_PROTOCOL;
if (!['siwc', 'anthropic'].includes(mode) || !process.env.CB_TEST_MODEL_LOG) throw Error('Missing isolated model fixture');
let requests = 0;
const stream = events => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
ProxyFetchPool.prototype.forEndpoint = function () {
  return async (url, init) => {
    requests++;
    const body = JSON.parse(init.body), headers = new Headers(init.headers);
    assert.equal(String(url), mode === 'siwc' ? 'https://api.openai.com/v1/responses' : 'https://opencode.ai/zen/go/v1/messages');
    assert.equal(headers.get(mode === 'siwc' ? 'authorization' : 'x-api-key'), mode === 'siwc'
      ? `Bearer PRIVATE_ACCESS_${requests === 1 ? 1 : 2}` : 'PRIVATE_CLAUDE_KEY');
    await appendFile(process.env.CB_TEST_MODEL_LOG, JSON.stringify({ url: String(url), body }) + '\n');
    if (mode === 'siwc' && requests === 1) return Response.json({ error: { code: 'invalid_token' } }, { status: 401 });
    const toolRound = requests === (mode === 'siwc' ? 2 : 1);
    if (!toolRound) {
      assert.equal(requests, mode === 'siwc' ? 3 : 2, 'No extra retry or tool round');
      assert.ok(JSON.stringify(body).includes('LOCAL_FILE_EVIDENCE'), 'The actual local file must be read and returned to the model');
    }
    const args = { path: process.env.CB_TEST_MODEL_FILE };
    if (mode === 'siwc') {
      assert.equal(body.store, false); assert.equal(body.stream, true);
      const item = toolRound
        ? { type: 'function_call', id: 'fc-read', call_id: 'read', name: 'read_file', arguments: JSON.stringify(args), status: 'completed' }
        : { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'CLI verified local file.', annotations: [] }] };
      return stream([{ type: 'response.completed', response: { id: `r-${requests}`, status: 'completed', store: false, model: body.model, output: [item] } }]);
    }
    const block = toolRound ? { type: 'tool_use', id: 'read', name: 'read_file', input: args } : { type: 'text', text: 'CLI verified local file.' };
    return stream([
      { type: 'message_start', message: { id: `r-${requests}`, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 100, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: block }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
    ]);
  };
};

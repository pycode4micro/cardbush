import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';
const ui = await loadChatTranscript({ conditions: ['node'], globals: { TextEncoder, TextDecoder, process: { env: { NODE_ENV: 'production' } } }, source: `export * from ${JSON.stringify(path.resolve('web/artifacts.ts'))}; export { webToolExecution } from ${JSON.stringify(path.resolve('web/transcript.ts'))};` });
const image = '/data/workspaces/generated/针织 开衫.png';
const name = 'mcp__plugin_volcengine_images_images__generation_wait_tasks';
const message = (extra = {}) => ({ id:'reply', role:'assistant', content:'', turnId:'turn-a', conversationId:'session-a', ...extra });
const task = (extra = {}) => ({ kind:'seedream', status:'succeeded', result:{data:[{local_path:image}]}, ...extra });
const receipt = value => ({ mcp:{name}, result:{structuredContent:value} });
const plain = value => JSON.parse(JSON.stringify(value));

test('turn downloads include authored outputs once, without reference uploads, videos, external or code-example files', () => {
  const output = message({content:`![图](<${image}>)\n\n[再次下载](<${image}>)\n\n![参考](/data/workspaces/uploads/source.png)\n\n![外部](https://example.test/out.png)\n\n[视频](/data/workspaces/generated/out.mp4)\n\n\`![示例](/data/workspaces/generated/example.png)\``,
    loopHistory:[message({id:'earlier', content:`![中间产物](<${image}>)`}), message({id:'user',role:'user',attachments:[{type:'image',path:'/data/workspaces/generated/input.png'}]})]});
  assert.deepEqual(plain(ui.webTurnArtifacts(output)).map(item=>item.path),[image]);
});
test('only completed native image receipts yield downloads, including batched asynchronous wait results', () => {
  const result=ui.imageReceiptArtifacts(name,receipt({items:[{observation:{task:task()}},{observation:{task:task()}},{observation:{task:task({status:'running'})}}]}));
  assert.deepEqual(plain(result).map(item=>item.path),[image]);
  assert.equal(ui.imageReceiptArtifacts('read_file',receipt({task:task()})).length,0);
  assert.equal(ui.imageReceiptArtifacts(name,receipt({task:task({kind:'video'})})).length,0);
  assert.equal(ui.imageReceiptArtifacts(name,{result:{hidden:{local_path:image}},content:[{type:'text',text:JSON.stringify({task:task()})}]}).length,0);
});
test('personal generated output validation rejects traversal, other directories and arbitrary protocols', () => {
  for(const source of ['/data/workspaces/generated/../secret.png','/data/workspaces/generated/%2e%2e/secret.png','/data/workspaces/other-user/x.png','/data/workspaces/generated-other/x.png','file://remote/data/workspaces/generated/x.png','//external/x.png','https://example.test/x.png','data:image/png;base64,abcd','/data/workspaces/generated/x.svg']) assert.equal(ui.generatedImagePath(source),null,source);
  assert.equal(ui.generatedImagePath('file:///data/workspaces/generated/%E9%92%88%E7%BB%87%20%E5%BC%80%E8%A1%AB.png'),image);
});
test('historical summaries defer image results; hydrating the real receipt restores artifacts even without a Markdown link', () => {
  const summary={recordedAt:'2026-10-11T00:00:00Z',turnId:'turn-a',ordinal:0,round:1,toolCall:{id:'tool',name},outcome:'returned',resultAvailable:true,workspaceChanges:[]};
  const projected=ui.webToolExecution(summary);
  assert.equal(ui.hasDeferredImageArtifacts(message({toolExecutions:[projected]})),true);
  assert.equal(ui.webTurnArtifacts(message({toolExecutions:[projected]})).length,0);
  const full=ui.webToolExecution({...summary,result:receipt({task:task()})});
  assert.deepEqual(plain(ui.webTurnArtifacts(message({toolExecutions:[full]}))).map(item=>item.path),[image]);
  assert.equal(ui.hasDeferredImageArtifacts(message({toolExecutions:[full]})),false);
  assert.equal(ui.webTurnArtifacts(message({toolExecutions:[ui.webToolExecution({...summary,outcome:'failed',result:receipt({task:task()})})]})).length,0);
});
test('artifact menus keep each conversation and turn scoped, and ordinary chat produces no menu', () => {
  const foreign=message({turnId:'other-turn',content:`![图](<${image}>)`});
  const another=message({conversationId:'other-account-session',content:`![图](<${image}>)`});
  assert.equal(ui.webTurnArtifacts(message({loopHistory:[foreign,another]})).length,0);
  assert.equal(ui.webTurnArtifacts(message({content:'只有文字的回复'})).length,0);
  assert.equal(ui.hasDeferredImageArtifacts(message()),false);
});

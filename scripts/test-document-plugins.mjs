import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, cp, mkdir, copyFile, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadProductPluginCatalog, loadEnabledProductPluginMcpServers, loadEnabledProductPluginSkillRootEntries } from '../dist-electron/productPlugins.js';
import { listProductSkills } from '../dist-electron/productSkills.js';
import { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import { InMemoryRuntimeHost, SessionStore, SubagentTaskStore, ToolExecutionCoordinator, ToolRegistry } from '@cardbush/bush-runtime';
import { libraries } from '@cardbush/document-tools/sdk';
import { McpClientManager } from '../packages/bush-mcp-client/dist/index.js';

const ids = ['xlsx', 'pptx', 'docx', 'pdf'];
const roots = [{ path: resolve('assets/plugins'), source: 'bundled' }];
const require = createRequire(import.meta.url);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-document-plugins-'));
  t.after(async () => {
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const config = join(root, 'apps.json');
  const servers = () => loadEnabledProductPluginMcpServers(roots, config, [], join(root, 'data'));
  return { root, config, servers };
}

test('document plugins install by default and disable/uninstall hides their skills and MCP together', async t => {
  const f = await fixture(t), catalog = await loadProductPluginCatalog(roots);
  for (const id of ids) {
    const plugin = catalog.find(p => p.id === id);
    assert.equal(plugin.installation, 'INSTALLED_BY_DEFAULT');
    assert.deepEqual(plugin.components.map(c => c.kind), ['skill', 'mcp']);
    // A leftover Python cache directory is not a discoverable skill.
    await assert.rejects(access(resolve('assets/skills', id, 'SKILL.md')), 'the standalone duplicate skill entry must be removed');
  }
  assert.deepEqual((await f.servers()).map(s => s.id), ids.map(id => `plugin_${id}_documents`));
  const skills = await loadEnabledProductPluginSkillRootEntries(roots, f.config);
  assert.deepEqual(skills.filter(s => ids.includes(s.pluginId)).map(s => s.pluginId), ids);
  assert.deepEqual((await listProductSkills(skills.map(s => s.path))).filter(s => ids.includes(s.name.split(':')[0])).map(s => s.name).sort(), ids.map(id => `${id}:${id}`).sort());
  await writeFile(f.config, JSON.stringify({ serviceEnabled: true, plugins: [{ id: 'xlsx', installed: true, enabled: true }] }));
  const imported = (await loadEnabledProductPluginMcpServers([{ ...roots[0], source: 'user' }], f.config)).find(s => s.pluginId === 'xlsx');
  assert.ok(imported, 'the user-installed reader is still available');
  assert.equal(imported.attachmentReaders, undefined, 'package claims alone do not bind an imported reader to attachment approval');
  await writeFile(f.config, JSON.stringify({ serviceEnabled: true, plugins: [
    { id: 'xlsx', installed: true, enabled: false }, { id: 'docx', installed: false, enabled: false },
  ] }));
  assert.deepEqual((await f.servers()).map(s => s.id), ['plugin_pptx_documents', 'plugin_pdf_documents']);
  assert.deepEqual((await loadEnabledProductPluginSkillRootEntries(roots, f.config)).filter(s => ids.includes(s.pluginId)).map(s => s.pluginId), ['pptx', 'pdf']);
  await writeFile(f.config, JSON.stringify({ serviceEnabled: false, plugins: [] }));
  assert.deepEqual(await f.servers(), []);
});

const scripts = {
  xlsx: `const book = new tools.ExcelJS.Workbook(); book.addWorksheet('Test').addRow(['MCP round trip', 7]); await book.xlsx.writeFile(outputs[0]);`,
  pptx: `const ppt = new tools.PptxGenJS(); ppt.addSlide().addText('MCP round trip', {x:1,y:1,w:8,h:1}); await ppt.writeFile({fileName:outputs[0]});`,
  docx: `const {Document, Paragraph, Packer} = tools.docx; await tools.fs.writeFile(outputs[0], await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('MCP round trip')]}]})));`,
  pdf: `const doc = await tools.PDFLib.PDFDocument.create(); doc.addPage().drawText('MCP round trip'); await tools.fs.writeFile(outputs[0], await doc.save());`,
};

for (const kind of ids) test(`${kind} launches from the product configuration and performs a real MCP round trip`, { timeout: 90000 }, async t => {
  const f = await fixture(t), server = (await f.servers()).find(s => s.id === `plugin_${kind}_documents`);
  assert.equal(server.transport.command, process.execPath);
  assert.equal(server.transport.env.CARDBUSH_DOCUMENT_TOOLS_ENTRY, require.resolve('@cardbush/document-tools/server'));
  assert.equal(server.transport.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(server.attachmentReaders.inspect_document.pathArgument, 'path');
  assert.deepEqual(Object.keys(server.attachmentReaders), ['inspect_document']);
  const client = new Client({ name: 'document-plugin-contract', version: '1' });
  assert.equal(server.transport.cwd, server.transport.env.PLUGIN_DATA, 'a real directory is required outside app.asar');
  const registry = new ToolRegistry();
  const manager = new McpClientManager({ registry, createClient: () => client });
  try {
    await manager.apply({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'document-round-trip', revision: 1, servers: [server] });
    const { tools } = await client.listTools();
    assert.equal(tools.length, kind === 'pptx' ? 5 : 4);
    assert.ok(tools.find(tool => tool.name === 'author_document').inputSchema.required.includes('code'));
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.equal(result.structuredContent, undefined);
      return JSON.parse(result.content[0].text);
    };
    assert.equal((await call('document_environment', {})).ready, true);
    const file = join(f.root, `通过 MCP 生成.${kind}`);
    const result = await call('author_document', { outputs: [file], code: scripts[kind] });
    assert.equal(result.status, 'created');
    const attached = await realpath(file), requests = [];
    const coordinator = new ToolExecutionCoordinator({ registry, isTurnAttachment: path => path === attached,
      permissions: { async request(request) {
        requests.push(request);
        return request.actions.includes('write') ? { decision: 'deny', grantedCapabilityIds: [] }
          : { decision: 'allow_once', grantedCapabilityIds: request.capabilityIds };
      } },
    });
    const execute = (tool, args, round) => coordinator.execute({
      protocol: 'bush.tool_call.v1', id: `call-${round}`, name: `mcp__plugin_${kind}_documents__${tool}`, argumentsText: JSON.stringify(args),
    }, { requestId: 'document-test', sessionId: 'child', turnId: 'task', round, ordinal: 0 });
    for (const offset of [0, 1]) {
      const receipt = await execute('inspect_document', { path: attached, offset, limit: 1, expected_sha256: result.outputs[0].sha256 }, offset + 1);
      assert.equal(receipt.kind, 'returned', JSON.stringify(receipt));
      assert.equal(receipt.resultError, undefined, JSON.stringify(receipt.result));
      const inspected = JSON.parse(receipt.result.content[0].text);
      assert.equal(inspected.sha256, result.outputs[0].sha256);
      if (offset === 0) assert.match(JSON.stringify(inspected), /MCP round trip/);
    }
    assert.equal(requests.length, 1, 'both inspections use the same approved attachment');
    const write = await execute('author_document', { code: scripts[kind], inputs: [{ path: attached }], outputs: [join(f.root, `blocked.${kind}`)] }, 3);
    assert.equal(write.error?.code, 'permission_rejected');
    assert.deepEqual(requests.map(request => request.actions), [['external_tool_call', 'read'], ['external_tool_call', 'read', 'write']]);
  } finally { await manager.close(); }
});

for (const assistant of [true, false]) test(`${assistant ? 'Assistant' : 'ordinary chat'} replays 30 Excel inspections with one attachment approval`, { timeout: 60000 }, async t => {
  const f = await fixture(t), registry = new ToolRegistry(), tasks = new SubagentTaskStore();
  const server = (await f.servers()).find(server => server.pluginId === 'xlsx');
  const manager = new McpClientManager({ registry });
  const beginChild = Promise.withResolvers();
  const sessionId = assistant ? PERSONAL_ASSISTANT_SESSION : 'ordinary-document-test';
  const sessions = new SessionStore();
  sessions.ensureSession(sessionId);
  // Reproduce the 24 worksheet reads and six extra pages without retaining user data.
  const { ExcelJS } = await libraries('xlsx');
  const workbook = new ExcelJS.Workbook();
  const pages = Array.from({ length: 24 }, (_, index) => ({ sheet: 'Sheet ' + (index + 1), offset: 0, limit: [1, 3, 6, 9, 20, 25][index % 6] }));
  for (const { sheet } of pages) {
    const page = workbook.addWorksheet(sheet);
    for (let row = 1; row <= 30; row++) page.addRow([sheet, row]);
  }
  pages.push(...[2, 6, 16, 2, 6, 16].map((offset, index) => ({ sheet: pages[index].sheet, offset, limit: 3 })));
  const source = join(f.root, 'attached-workbook.xlsx'), other = join(f.root, 'other-workbook.xlsx');
  await workbook.xlsx.writeFile(source);
  await copyFile(source, other);

  const inspect = 'mcp__plugin_xlsx_documents__inspect_document';
  const approvals = [];
  const resultText = 'The workbook inspections are complete.';
  let childRound = 0, dispatched = false, completion = false, childPath;
  const host = new InMemoryRuntimeHost({ dataRoot: join(f.root, 'runtime'), toolRegistry: registry, subagentTaskStore: tasks, sessionStore: sessions,
    loadPluginExtensions: async () => ({ skills: [], agents: [], hooks: [] }),
    provider: { async *stream(request) {
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      let calls = [], text = '';
      if (request.metadata.agentRole === 'child') {
        const round = childRound++;
        if (round === 0) {
          await beginChild.promise;
          const context = request.messages.find(message => message.role === 'user' &&
            message.content.includes(assistant ? 'Attached references (data;' : 'Attached files:\n'));
          assert.ok(context, 'the child receives the retained attachment reference');
          childPath = assistant ? JSON.parse(context.content.split('\n').at(-1))[0].localPath
            : JSON.parse(context.content.split('Attached files:\n')[1].split('\n')[0]);
          assert.notEqual(childPath, source, 'read the retained attachment, not its original path');
          calls = [{ id: 'load-inspect', name: 'get_tool_schema', args: { name: inspect } }];
        } else if (round <= 5) {
          calls = pages.slice((round - 1) * 6, round * 6).map((page, i) => ({ id: `page-${round}-${i}`,
            name: 'call_tool', args: { name: inspect, arguments: { path: childPath, ...page } } }));
        } else if (round === 6) {
          calls = [{ id: 'other-file', name: 'call_tool', args: { name: inspect, arguments: { path: other, ...pages[0] } } }];
        } else text = resultText;
      } else {
        const notice = request.messages.filter(message => message.name === 'child_interaction')
          .map(message => JSON.parse(message.content.split('\n').at(-1)))
          .find(interaction => !approvals.some(previous => previous.interactionId === interaction.interactionId));
        if (notice) {
          assert.equal(notice.authority, 'parent_delegate');
          approvals.push(notice);
          calls = [{ id: `approval-${approvals.length}`, name: 'subagent', args: { task_id: notice.taskId,
            response: { kind: 'permission', interactionId: notice.interactionId, actionDigest: notice.actionDigest, decision: 'allow_once' } } }];
        } else if (!dispatched) {
          dispatched = true;
          calls = [{ id: 'dispatch', name: 'subagent', args: { prompt: 'Read the attached workbook in pages, then inspect the other workbook.', run_in_background: true } }];
        } else if (request.messages.some(message => ['background_task_result', 'subagent_result', 'plugin_hook_feedback'].includes(message.name) &&
          message.content.includes(resultText))) {
          completion = true;
          text = 'Delivered the workbook result.';
        } else text = 'The inspection is running.';
      }
      let sequence = 0;
      yield { ...base, sequence: sequence++, kind: 'response_started' };
      for (const [index, call] of calls.entries()) yield { ...base, sequence: sequence++, kind: 'tool_call_delta',
        index, toolCallId: call.id, nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) };
      if (text) yield { ...base, sequence: sequence++, kind: 'text_delta', delta: text };
      yield { ...base, sequence, kind: 'response_completed', finishReason: calls.length ? 'tool_calls' : 'stop' };
    } },
  });
  const content = 'Inspect the attached workbook by sheet and page.';
  const attachment = { id: 'attached-workbook', name: 'attached-workbook.xlsx', path: source, type: 'document' };
  const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId, ...payload } });
  const until = async (condition, message) => {
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await delay(20);
    }
    assert.fail(message);
  };
  try {
    await manager.apply({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'excel-attachment-replay', revision: 1, servers: [server] });
    assert.ok(registry.resolve(inspect));
    const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'document-request', sessionId, turnId: 'document-turn',
      model: 'fixture', prefixMessages: [], permissionMode: assistant ? 'all_free' : 'ask_for_approval', tools: registry.definitions(),
      inputMessages: [{ messageId: 'user-file', message: { role: 'user', content }, metadata: { attachments: [attachment] } }],
      metadata: { subagentPermissionRouting: 'parent', assistantOutputMode: 'text', individuation: { habits: false, predictions: false } } };
    if (assistant) {
      await command({ action: 'turn', parent, profile: assistantProfileSchema.parse({}), entry: {
        id: 'user-file', content, role: 'user', source: 'text', visibility: 'conversation', createdAt: new Date().toISOString(), attachments: [attachment],
      } });
      await until(async () => !(await command({ action: 'read' })).busy, 'Assistant finished dispatching');
      assert.equal((await command({ action: 'read' })).error, '');
    } else assert.equal((await host.runSessionTurn(parent)).payload.status, 'completed');
    beginChild.resolve();
    await until(() => tasks.list(sessionId).some(task => task.status !== 'running'), 'the delegated workbook task finishes');
    const [task] = tasks.list(sessionId);
    assert.equal(task.status, 'completed', task.errorMessage);
    const events = host.events(task.childSessionId, task.childTurnId);
    const inspections = events.filter(event => event.kind === 'tool_returned' && !event.payload.resultError &&
      /^(page-|other-file)/.test(event.payload.toolCallId));
    assert.equal(inspections.length, 31, JSON.stringify(events.flatMap(event => [event.payload.error, event.payload.resultError].filter(Boolean))));
    assert.deepEqual(approvals.map(notice => notice.resources.find(resource => resource.kind === 'filesystem_path').value), [childPath, other]);
    if (!assistant) await host.runSessionTurn({ ...parent, requestId: 'follow-up', turnId: 'follow-up',
      inputMessages: [{ messageId: 'follow-up-user', message: { role: 'user', content: 'Tell me the inspection result.' } }],
    });
    await until(() => completion, 'the child result still reaches its parent');
  } finally {
    beginChild.resolve();
    await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    await manager.close();
  }
});

test('document launcher also runs under the shipped Electron executable', { skip: !['win32', 'linux'].includes(process.platform), timeout: 45000 }, async t => {
  const f = await fixture(t), server = (await f.servers()).find(s => s.id === 'plugin_pdf_documents');
  const client = new Client({ name: 'electron-document-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ ...server.transport, command: require('electron'),
    env: { ...process.env, ...server.transport.env, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' }));
  const result = await client.callTool({ name: 'document_environment', arguments: {} });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(JSON.parse(result.content[0].text).ready, true);
  await client.close();
});

test('ASAR plugin and worker can create and render a PDF with a real external working directory', { timeout: 45000 }, async t => {
  // Dependencies resolve from the development node_modules, mirroring unpacked native dependencies.
  const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'document-asar-'));
  t.after(async () => { assert.equal(dirname(root), parent); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const stage = join(root, 'stage'), archive = join(root, 'app.asar');
  await cp(resolve('packages/cardbush-document-tools/dist'), join(stage, 'packages/cardbush-document-tools/dist'), { recursive: true });
  await cp(resolve('assets/plugins/pdf'), join(stage, 'assets/plugins/pdf'), { recursive: true });
  const { createPackage } = await import('@electron/asar');
  await createPackage(stage, archive);
  const client = new Client({ name: 'asar-document-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: require('electron'), args: [join(archive, 'assets/plugins/pdf/server.cjs')], cwd: root,
    env: { ELECTRON_RUN_AS_NODE: '1', CARDBUSH_DOCUMENT_TOOLS_ENTRY: join(archive, 'packages/cardbush-document-tools/dist/server.mjs'),
      CARDBUSH_PROCESS_HOST_DIRECTORY: resolve('dist-native/process-guard') }, stderr: 'pipe' }));
  const file = join(root, 'from-asar.pdf'), image = join(root, 'from-asar.png');
  const created = await client.callTool({ name: 'author_document', arguments: { outputs: [file], code: scripts.pdf } });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  const rendered = await client.callTool({ name: 'render_pdf_page', arguments: { path: file, output: image, page: 1 } });
  assert.equal(rendered.isError, undefined, JSON.stringify(rendered));
  assert.ok(rendered.content.some(item => item.type === 'image' && item.mimeType === 'image/png'));
  await client.close();
});

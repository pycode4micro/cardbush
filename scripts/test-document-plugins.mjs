import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, cp, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ManagedStdioClientTransport } from '../packages/bush-mcp-client/dist/managedStdio.js';
import { loadProductPluginCatalog, loadEnabledProductPluginMcpServers, loadEnabledProductPluginSkillRootEntries } from '../dist-electron/productPlugins.js';
import { listProductSkills } from '../dist-electron/productSkills.js';

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
  const client = new Client({ name: 'document-plugin-contract', version: '1' });
  assert.equal(server.transport.cwd, server.transport.env.PLUGIN_DATA, 'a real directory is required outside app.asar');
  const transport = new ManagedStdioClientTransport(server.transport);
  t.after(() => client.close());
  await client.connect(transport);
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
  const inspected = await call('inspect_document', { path: file, limit: 1, expected_sha256: result.outputs[0].sha256 });
  assert.match(JSON.stringify(inspected), /MCP round trip/);
  await client.close();
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createCardbushBrowserServer } from '../dist/index.js';

test('MCP discovery explains local consent and reconnection before manual or remote pairing', async t => {
  const server = createCardbushBrowserServer({ connector: async () => { assert.fail('Discovery must not connect or request consent'); } });
  const client = new Client({ name: 'browser-guidance-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const catalog = await client.listTools();
  const descriptions = [client.getInstructions(), ...['list_browsers', 'select_browser'].map(name => {
    const tool = catalog.tools.find(tool => tool.name === name);
    assert.ok(tool, name); return tool.description;
  })];
  for (const description of descriptions) {
    assert.match(description, /local Chrome\/Edge.*user approves the first connection.*once in the CardBush extension window/);
    assert.doesNotMatch(description, /system dialog|both dialogs/);
    assert.match(description, /no pairing code is needed/);
    assert.match(description, /local App and CLI share.*reconnect automatically.*restarts/);
    assert.match(description, /Chrome\/Edge without the App running/);
    assert.match(description, /\/browser pair chrome or \/browser pair edge only for manual connection or remote Agent pairing/);
    assert.match(description, /remote Agents keep connections separate from the local App\/CLI/);
    assert.match(description, /Do not generate a new pairing code for a temporary disconnect/);
    assert.match(description, /Integrated CardBush tabs require the desktop App, but no extension or pairing/);
    assert.ok(description.indexOf('no pairing code is needed') < description.indexOf('/browser pair'), 'normal local setup comes first');
    assert.doesNotMatch(description, /work in the CLI after \/browser pair|pairings (?:are )?managed separately/);
  }
});

test('shipped skills, plugin metadata and setup help agree about local and remote connections', async () => {
  const read = file => readFile(new URL('../../../' + file, import.meta.url), 'utf8');
  const plugin = JSON.parse(await read('assets/plugins/browser/.codex-plugin/plugin.json'));
  for (const description of [plugin.description, plugin.interface.longDescription]) {
    assert.match(description, /first-use approval|one confirmation in the CardBush extension window/);
    assert.doesNotMatch(description, /system dialog|both dialogs/);
    assert.match(description, /automatic reconnection|reconnect automatically/);
    assert.match(description, /manual connection or remote Agent pairing/);
  }
  for (const file of ['assets/plugins/browser/skills/browser-use/SKILL.md', 'assets/skills/cardbush-docs/references/browser-use.md',
    'docs/CORE_BROWSER_COMPUTER_USE.md', 'assets/plugins/browser/extension/popup.html']) {
    let content = await read(file);
    if (file.endsWith('popup.html')) {
      assert.match(content, /id="connection-help"/);
      content += JSON.parse(await read('src/i18n/locales/zh.json')).messages['browser.extension.connectionHelp'];
    }
    assert.match(content, /CardBush 风格的扩展窗口确认一次/, file);
    assert.doesNotMatch(content, /系统弹窗|双重确认/, file);
    assert.match(content, /无需(?:输入|复制)配对码/, file);
    assert.match(content, /本机 App 和 CLI 共用连接/, file);
    assert.match(content, /自动重连/, file);
    if (file.endsWith('popup.html')) {
      assert.match(content, /首次注册连续失败 3 轮后停止/);
      assert.match(content, /已保存的连接.*每 30 秒自动重连/);
    }
    assert.match(content, /仅用于手动连接或远程 Agent 配对/, file);
    assert.match(content, /远程 Agent 独立管理连接/, file);
    assert.doesNotMatch(content, /桌面 App 的连接与 CLI 分开管理|CLI 与桌面 App 的配对分别管理|首次使用[^。\n]*生成配对码/, file);
  }
  assert.match(plugin.cardbush.localizations.zh.longDescription, /首次.*无需输入配对码.*共用连接.*自动重连.*仅用于手动连接或远程 Agent 配对/);
  for (const file of ['docs/CORE_BROWSER_COMPUTER_USE.en.md', 'assets/plugins/browser/extension/README.md']) {
    const content = await read(file);
    assert.match(content, /(?:no|No)(?: system dialog or)? pairing code is needed/, file);
    assert.match(content, /(?:manual connection or remote Agent pairing)/, file);
    assert.match(content, /\/browser status/, file);
    assert.match(content, /Remote (?:Agents|workers) (?:keep separate connections|retain manual pairing)/, file);
  }
});

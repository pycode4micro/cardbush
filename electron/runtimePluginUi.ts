import { dialog, shell, type BrowserWindow, type IpcMain } from 'electron';
import { readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnabledProductRuntimeRenderers, loadEnabledProductPlugins, type PluginRoot } from './productPlugins';

export function registerRuntimePluginUiIpc(ipc: IpcMain, options: {
  dataRoot: () => string; roots: () => PluginRoot[]; configPath: () => string;
  window: () => BrowserWindow | null; assertSender: (id: number) => void;
}) {
  ipc.handle('plugins:runtime-renderers', async event => {
    options.assertSender(event.sender.id);
    return loadEnabledProductRuntimeRenderers(options.roots(), options.configPath());
  });
  ipc.handle('plugins:extension-file', async (event, input: { pluginId: string; action: 'import' | 'export' | 'reveal'; text?: string; name?: string; yaml?: string }) => {
    options.assertSender(event.sender.id);
    const plugin = (await loadEnabledProductPlugins(options.roots(), options.configPath())).find(plugin => plugin.id === input.pluginId && plugin.runtimeExtensions?.length);
    if (!plugin) throw new Error('Plugin is not installed and enabled.');
    if (input.action === 'reveal') {
      const directory = join(options.dataRoot(), plugin.id);
      const error = await shell.openPath(directory);
      if (error) throw new Error(error);
      return directory;
    }
    const parent = options.window();
    if (input.action === 'import') {
      const settings = { properties: ['openFile' as const], filters: [{ name: 'Configuration', extensions: ['json', 'yaml', 'yml'] }] };
      const picked = await (parent ? dialog.showOpenDialog(parent, settings) : dialog.showOpenDialog(settings));
      if (picked.canceled || !picked.filePaths[0]) return null;
      if ((await stat(picked.filePaths[0])).size > 2_000_000) throw new Error('Configuration exceeds 2 MB.');
      const text = await readFile(picked.filePaths[0], 'utf8');
      if (Buffer.byteLength(text) > 2_000_000) throw new Error('Configuration exceeds 2 MB.');
      return text;
    }
    if (input.action === 'export') {
      if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 2_000_000) throw new Error('Invalid configuration export.');
      if (input.yaml !== undefined && (typeof input.yaml !== 'string' || Buffer.byteLength(input.yaml) > 2_000_000)) throw new Error('Invalid YAML export.');
      const settings = { defaultPath: basename(input.name || 'configuration.json'), filters: [{ name: 'JSON', extensions: ['json'] }, ...(input.yaml === undefined ? [] : [{ name: 'YAML', extensions: ['yaml', 'yml'] }])] };
      const picked = await (parent ? dialog.showSaveDialog(parent, settings) : dialog.showSaveDialog(settings));
      if (picked.canceled || !picked.filePath) return null;
      const temporary = `${picked.filePath}.${randomUUID()}.tmp`;
      const { replaceFile } = await import('@cardbush/product-host');
      try { await writeFile(temporary, /\.ya?ml$/i.test(picked.filePath) && input.yaml !== undefined ? input.yaml : input.text, { flag: 'wx' }); await replaceFile(temporary, picked.filePath); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return picked.filePath;
    }
    throw new Error('Unsupported plugin configuration file action.');
  });
}

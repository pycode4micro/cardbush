import { activePluginRuntime, type PluginRuntime } from '@cardbush/platform';
import { managePluginRuntime } from './pluginRuntimeManager.mjs';

export async function main(args = process.argv.slice(3)) {
  const [action = 'list', name, version] = args;
  if (action === '--help' || action === '-h') {
    console.log('CardBush plugin runtimes\n\ncardbush runtime list\ncardbush runtime install <node|python> [series-or-version]\ncardbush runtime update <node|python>\ncardbush runtime use <node|python> <installed-version>\ncardbush runtime path <node|python>\n\nInstall defaults to Node 24 or Python 3.12. Update stays on the active Node major or Python minor. New plugin processes use the selected version.');
    return 0;
  }
  if (args.length > 3 || (name !== undefined && name !== 'node' && name !== 'python')) throw Error('Use cardbush runtime --help.');
  const kind = name as PluginRuntime | undefined;
  if (action === 'path') {
    if (!kind || version !== undefined) throw Error('Use cardbush runtime path <node|python>.');
    const runtime = activePluginRuntime(kind);
    if (!runtime) throw Error(`No managed ${kind} selected. Run cardbush runtime install ${kind}.`);
    console.log(runtime.executable);
  } else {
    if (action !== 'list' && action !== 'install' && action !== 'update' && action !== 'use') throw Error('Use cardbush runtime --help.');
    for (const item of await managePluginRuntime(action, kind, version)) {
      console.log(`${item.kind}: ${item.active ?? 'not installed'} (installed: ${item.versions.join(', ') || 'none'})`);
    }
  }
  return 0;
}

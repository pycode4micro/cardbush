import { join } from 'node:path';
import type { RuntimeExtensionFactory } from '@cardbush/bush-runtime';
import { createTeamRuntimeExtension } from './index.js';
import { TeamConfigurationFileStore, decodeTeamConfigurationFile, encodeTeamConfigurationFile } from './configStore.js';

export const apiVersion = 1;
const activate: RuntimeExtensionFactory = api => {
  if (!api.dataDirectory) throw new Error('The host did not supply the plugin data directory.');
  const store = new TeamConfigurationFileStore(join(api.dataDirectory, 'teams.json'));
  const extension = createTeamRuntimeExtension(api);
  extension.commands['plugin.team.configuration'] = async payload => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid Team configuration request.');
    const input = payload as Record<string, unknown>;
    switch (input.action) {
      case 'read': return store.read(input.migration);
      case 'write': return store.write(input.configuration, String(input.expectedHash ?? ''));
      case 'decode': return decodeTeamConfigurationFile(String(input.text ?? ''));
      case 'encode': return encodeTeamConfigurationFile(input.configuration, input.format === 'yaml' ? 'yaml' : 'json');
      default: throw new Error('Unsupported Team configuration action.');
    }
  };
  return extension;
};
export default activate;

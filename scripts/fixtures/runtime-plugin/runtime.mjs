import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const apiVersion = 1;
export default api => {
  let snapshot = { items: [] };
  const path = join(api.dataDirectory, 'configuration.json');
  const read = async () => {
    try { return { ...JSON.parse(await readFile(path, 'utf8')), path }; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { path, contentHash: '0', configuration: { items: [
        { id: 'sample', name: 'Sample', description: 'First item' },
        { id: 'alternate', name: 'Alternate', description: 'Second item' },
      ] } };
    }
  };
  api.tools.register({
    definition: { name: 'fixture_read', description: 'Fixture', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture-runtime', dispatch_scope: 'parent_session', mutating: false },
    decodeInput: value => value, execute: () => ({ ok: true }),
  });
  return { id: 'fixture-runtime', features: ['fixture_extension'], commands: {
    'plugin.fixture.configuration': async input => {
      const receipt = await read();
      if (input.action === 'read') return receipt;
      if (input.expectedHash !== receipt.contentHash) throw Error('changed');
      const next = { path, contentHash: String(Number(receipt.contentHash) + 1), configuration: input.configuration };
      await mkdir(api.dataDirectory, { recursive: true });
      await writeFile(path, JSON.stringify(next));
      return next;
    },
    'plugin.fixture.apply_snapshot': input => (snapshot = input),
    'plugin.fixture.get_snapshot': () => snapshot,
  } };
};

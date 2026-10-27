import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeDistributionRoot } from '../dist/distributionRoot.js';

test('runtime assets belong to the enclosing release in workspace and bundled npm layouts', () => {
  const release = resolve('a release with spaces');
  for (const directory of ['packages/bush-runtime', 'node_modules/@cardbush/bush-runtime']) {
    assert.equal(runtimeDistributionRoot(pathToFileURL(join(release, directory, 'dist/distributionRoot.js')).href), release);
  }
  const scopedRelease = join(release, 'node_modules/@example/cardbush');
  assert.equal(runtimeDistributionRoot(pathToFileURL(join(scopedRelease,
    'node_modules/@cardbush/bush-runtime/dist/distributionRoot.js')).href), scopedRelease);
});

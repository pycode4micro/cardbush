import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const fixturePath = path.join(
  repositoryRoot,
  'packages',
  'bush-protocol',
  'reference-fixtures',
  'single-turn-stream.v1.json',
);
const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), 'cardbush-runtime-client-'),
);

try {
  const buildResult = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: temporaryDirectory,
      emptyOutDir: true,
      lib: {
        entry: path.join(repositoryRoot, 'src', 'runtime-client', 'index.ts'),
        formats: ['es'],
        fileName: 'runtime-client',
      },
    },
  });

  const buildOutputs = Array.isArray(buildResult) ? buildResult : [buildResult];
  const entryChunk = buildOutputs
    .flatMap((output) => output.output)
    .find((output) => output.type === 'chunk' && output.isEntry);
  assert.ok(entryChunk, 'Vite did not return a Runtime Client entry chunk.');
  const runtimeClientModule = await import(
    pathToFileURL(path.join(temporaryDirectory, entryChunk.fileName)).href
  );
  const fixtureInput = JSON.parse(await readFile(fixturePath, 'utf8'));
  const { client, fixture } =
    runtimeClientModule.createRuntimeFixtureClient(fixtureInput);
  const capabilities = await client.getCapabilities();

  assert.equal(capabilities.protocol, 'bush.runtime_capabilities.v1');
  assert.equal(capabilities.eventProtocol, 'bush.runtime_event.v1');
  assert.ok(capabilities.features.includes('reasoning_segments'));
  assert.ok(capabilities.features.includes('assistant_segments'));

  const projection = new runtimeClientModule.RuntimeTurnProjection();
  const eventKinds = [];
  let view = projection.snapshot();

  for await (const event of client.events({
    sessionId: 'session_fixture_001',
    turnId: 'turn_fixture_001',
  })) {
    eventKinds.push(event.kind);
    view = projection.apply(event);
    if (event.kind === 'assistant_segment_completed') {
      assert.equal(view.phase, 'running');
      assert.equal(view.terminal, undefined);
    }
  }

  assert.deepEqual(
    eventKinds,
    fixture.events.map(({ event }) => event.kind),
  );
  assert.equal(view.phase, 'completed');
  assert.equal(view.terminal?.reason, 'assistant_response_completed');
  assert.equal(
    view.reasoningSegments[0]?.content,
    '检查请求与可用事实。',
  );
  assert.equal(
    view.assistantSegments[0]?.content,
    '首轮 Runtime 流已接通。',
  );
  assert.notEqual(
    view.reasoningSegments[0]?.segmentId,
    view.assistantSegments[0]?.segmentId,
  );

  const beforeDuplicate = projection.snapshot();
  const afterDuplicate = projection.apply(fixture.events.at(-1).event);
  assert.deepEqual(afterDuplicate, beforeDuplicate);

  const invalidFixture = structuredClone(fixtureInput);
  invalidFixture.events[0].event.protocol = 'invalid.protocol';
  assert.throws(() =>
    runtimeClientModule.createRuntimeFixtureClient(invalidFixture),
  );

  console.log('Product Runtime Client contract passed.');
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

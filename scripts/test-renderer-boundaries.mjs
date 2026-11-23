import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';

async function productionChunks(configFile) {
  const warnings = [];
  const built = await build({
    ...(configFile ? { configFile: fileURLToPath(new URL(configFile, import.meta.url)) } : {
      root: fileURLToPath(new URL('../', import.meta.url)),
    }),
    logLevel: 'silent',
    build: {
      write: false,
      rolldownOptions: { onLog(level, log, next) { warnings.push(log); next(level, log); } },
    },
  });
  const chunks = (Array.isArray(built) ? built : [built]).flatMap(result => result.output)
    .filter(output => output.type === 'chunk');
  const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
  const moduleNames = chunk => Object.keys(chunk.modules).map(id => id.replaceAll('\\', '/'));
  const entry = name => {
    const found = chunks.find(chunk => chunk.isEntry && chunk.name === name);
    assert.ok(found, `missing renderer entry: ${name}`);
    return found;
  };
  const owner = suffix => {
    const found = chunks.find(chunk => moduleNames(chunk).some(id => id.endsWith(suffix)));
    assert.ok(found, `missing renderer module: ${suffix}`);
    return found;
  };
  const closure = (...roots) => {
    const seen = new Set();
    function visit(chunk) {
      if (seen.has(chunk)) return;
      seen.add(chunk);
      for (const name of chunk.imports) {
        const dependency = byName.get(name);
        assert.ok(dependency, `unexpected external browser import: ${name}`);
        visit(dependency);
      }
    }
    roots.forEach(visit);
    return [...seen];
  };
  return { warnings, chunks, entry, owner, closure, moduleNames };
}
const assertExcluded = (name, group, moduleNames, forbidden) => {
  assert.deepEqual(group.flatMap(moduleNames).filter(id => forbidden.test(id)), [],
    `${name} must not download or initialize unrelated state owners`);
};
function assertChunkBudget(chunks, warnings) {
  assert.equal(warnings.some(log => log.code === 'INEFFECTIVE_DYNAMIC_IMPORT'), false,
    'a module must not be both eagerly imported and presented as a deferred boundary');
  // Match Vite's existing 500 kB warning budget.
  assert.deepEqual(chunks.filter(chunk => Buffer.byteLength(chunk.code) > 500_000).map(chunk => chunk.name), [],
    'oversized production chunks need an explicit feature/library boundary');
}
function reportSizes(t, entries) {
  for (const [name, group] of Object.entries(entries)) {
    const bytes = group.reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0);
    t.diagnostic(`${name}: ${(bytes / 1024).toFixed(1)} KiB JS in ${group.length} static chunks (minified, before compression)`);
  }
}

// Manual chunk groups can create dependencies absent from the source graph.
test('production renderers load only the code needed by their window', async t => {
  const { warnings, chunks, entry, owner, closure, moduleNames } = await productionChunks();
  const main = entry('main');
  const boot = closure(main);
  const app = closure(main, owner('/src/App.tsx'));
  const shadow = closure(main, owner('/src/ShadowWindow.tsx'));
  const office = closure(entry('officePreview'));
  const model = closure(entry('modelPreview'));
  const history = closure(owner('/src/features/chat/TurnHistoryInspector.tsx'));
  const scene = closure(owner('/src/features/modelPreview/sceneView.ts'));
  const excludes = (name, group, forbidden) => assertExcluded(name, group, moduleNames, forbidden);
  excludes('bootstrap', boot, /\/src\/(?:App\.tsx|CardlingWindow\.tsx|ShadowWindow\.tsx|backend\/|hooks\/)/);
  excludes('shadow', shadow, /\/src\/(?:App\.tsx|CardlingWindow\.tsx|hooks\/useCardbushChat\.ts)/);
  excludes('Office preview', office, /\/src\/(?:App\.tsx|backend\/|hooks\/|runtime-client\/)|\/node_modules\/(?:react|react-dom|zod)\//);
  excludes('3D preview', model, /\/src\/(?:App\.tsx|backend\/|hooks\/|runtime-client\/)|\/node_modules\/(?:react|react-dom|zod)\//);
  excludes('3D loading/error shell', model, /\/node_modules\/three\//);
  excludes('3D scene engine', scene, /\/src\/(?:App\.tsx|backend\/|hooks\/|runtime-client\/)|\/node_modules\/(?:react|react-dom|zod)\//);
  excludes('workspace', app, /\/src\/(?:CardlingWindow\.tsx|features\/(?:SettingsView|agents\/AgentsView)\.tsx)|\/node_modules\/(?:three|@file-viewer)\//);
  const optionalPanels = /\/src\/features\/(?:subagents\/(?:SubagentConversation|SubagentTaskInspector)\.tsx|agents\/agentConversationBackend\.ts)/;
  excludes('workspace optional panels', app, optionalPanels);
  excludes('workspace execution history', app, /\/src\/features\/chat\/TurnHistoryInspector\.tsx$/);
  excludes('read-only turn history', history, optionalPanels);
  // ?url modules are inert asset addresses, not an initialized decoder.
  excludes('Office loading shell', office, /\/node_modules\/(?:styled-exceljs|@file-viewer\/renderer-(?:spreadsheet|pptx|ppt))\/[^?]+$/);
  excludes('retired Cardling', chunks, /\/src\/(?:CardlingWindow\.tsx|features\/cardling\/)/);
  excludes('browser dependencies', chunks, /\/node_modules\/zod\/.*\.cjs$/);
  assertChunkBudget(chunks, warnings);
  reportSizes(t, { bootstrap: boot, workspace: app, shadow, office, model, history, scene });
});

test('production Web loads authenticated and administrative pages on demand', async t => {
  const { warnings, chunks, entry, owner, closure, moduleNames } = await productionChunks('../vite.web.config.mts');
  const loginEntry = entry('index'), workspaceEntry = owner('/web/Workspace.tsx'), adminEntry = owner('/web/OrganizationAdmin.tsx');
  const login = closure(loginEntry);
  const workspace = closure(loginEntry, workspaceEntry);
  const admin = closure(loginEntry, workspaceEntry, adminEntry);
  assert.ok(loginEntry.dynamicImports.includes(workspaceEntry.fileName));
  assert.ok(workspaceEntry.dynamicImports.includes(adminEntry.fileName));
  assertExcluded('Web login', login, moduleNames, /\/web\/(?:Workspace|OrganizationAdmin|NativeTranscript)\.tsx$|\/node_modules\/react-virtuoso\//);
  assertExcluded('Web workspace', workspace, moduleNames, /\/web\/OrganizationAdmin\.tsx$/);
  assertChunkBudget(chunks, warnings);
  reportSizes(t, { login, workspace, admin });
});

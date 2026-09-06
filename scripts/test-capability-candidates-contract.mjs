import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const runtimeRailSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'composer', 'ComposerRuntimeRail.tsx'),
  'utf8',
);
const appSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'App.tsx'),
  'utf8',
);
const chatHookSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'hooks', 'useCardbushChat.ts'),
  'utf8',
);
assert.doesNotMatch(runtimeRailSource, /capabilityCandidates|能力建议|候选能力/);
assert.doesNotMatch(appSource, /activeCapabilityCandidates|capabilityCandidates/);
assert.doesNotMatch(chatHookSource, /capabilityCandidatesByConversation/);

console.log('capability candidates contract tests passed');

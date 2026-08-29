import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const shadow = read('src', 'backend', 'shadowRuntime.ts');
const api = read('src', 'backend', 'api.ts');

assert.match(shadow, /createDesktopRuntimeSession/);
assert.match(shadow, /hidden: true/);
assert.match(shadow, /temporary: true/);
assert.match(shadow, /shadowOfSessionId: input\.sessionId/);
assert.match(shadow, /sourceTurnIndex >= 0 \? sourceTurnIndex \+ 1 : source\.turns\.length/);
assert.match(shadow, /entry\.manifest\.dispatch_side_effect === 'none'/);
assert.match(shadow, /entry\.manifest\.operation === 'turn\.declare_outcome'/);
assert.match(shadow, /permissionMode: 'user_free'/);
assert.match(shadow, /shadowReadOnly: true/);
assert.match(shadow, /candidate\.metadata\?\.shadowConversationId === conversationId/);
assert.match(shadow, /runtime\.client\.deleteSession\(state\.runtimeSessionId\)/);
assert.doesNotMatch(shadow, /fetch\(|XMLHttpRequest|\/v1\//);
assert.match(api, /createRuntimeShadowConversation/);
assert.match(api, /streamRuntimeShadowConversationMessage/);
assert.match(api, /closeRuntimeShadowConversation/);

console.log('Shadow typed Runtime contract tests passed');

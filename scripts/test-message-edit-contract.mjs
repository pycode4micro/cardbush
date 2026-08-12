import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const bubbleSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chatMessages', 'MessageBubble.tsx'),
  'utf8',
);
assert.doesNotMatch(
  bubbleSource,
  /nextContent\.trim\(\)\s*===\s*message\.content\.trim\(\)/,
  'Update and rerun must still rerun when the content is unchanged',
);
assert.match(
  bubbleSource,
  /setSubmittingEdit\(true\);\s*setEditing\(false\);\s*try\s*{\s*await onEditUserMessage/,
  'The editor should close as soon as rerun starts so streaming feedback is visible',
);

const hookSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'hooks', 'useCardbushChat.ts'),
  'utf8',
);
assert.match(hookSource, /const editUserMessageAndRegenerate = useCallback/);
assert.match(hookSource, /editMessage\(\{\s*sessionId:\s*conversationId,\s*messageId,\s*content,/);

const apiSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'api.ts'),
  'utf8',
);
assert.match(apiSource, /method:\s*'PATCH'/);
assert.match(apiSource, /regenerate:\s*true/);
assert.match(apiSource, /truncate_after:\s*true/);

console.log('message edit and rerun contract tests passed');

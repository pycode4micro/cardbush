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
assert.match(
  hookSource,
  /editMessage\(\{\s*sessionId:\s*conversationId,\s*messageId,\s*content:\s*outbound\.userInput,/,
  'Update and rerun must send clean text separately from attachment paths',
);
assert.match(
  hookSource,
  /const editedUser:[\s\S]*?content:\s*outbound\.displayInput,[\s\S]*?attachments:\s*chatAttachmentsFromOutbound\(outbound\)/,
  'The edited optimistic bubble must keep attachment cards without exposing @ paths',
);

const apiSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'api.ts'),
  'utf8',
);
assert.match(apiSource, /runtime\.client\.supersedeSessionMessages\(\s*\{/);
assert.match(
  apiSource,
  /messageIds:\s*messages\s*\.slice\(supersedeFrom\)\s*\.map/,
);
assert.match(apiSource, /reason: 'user_edit_regenerate'/);
assert.match(apiSource, /streamRuntimeChat\(\{ \.\.\.request, userInput: content \}\)/);
assert.doesNotMatch(apiSource, /method:\s*'PATCH'|truncate_after/);

console.log('message edit and rerun contract tests passed');

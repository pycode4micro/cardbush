import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

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
assert.doesNotMatch(
  hookSource,
  /未定位到原消息，已作为新提问发送|original message was not found, so this was sent as a new request/i,
  'Update and rerun must fail closed instead of silently creating another Turn',
);
assert.match(
  hookSource,
  /\/\^message_\[\\w-\]\+\$\//,
  'Runtime user message_<uuid> identities must be recognized as durable edit targets',
);
assert.match(
  hookSource,
  /editMessage\(\{\s*sessionId:\s*conversationId,\s*messageId,\s*content:\s*outbound\.userInput,/,
  'Update and rerun must send clean text separately from attachment paths',
);
assert.match(
  hookSource,
  /const editedAttachments = optimisticAttachments\.length > 0[\s\S]*?: editSourceMessage\.attachments\?\.map[\s\S]*?const editedUser:[\s\S]*?content:\s*outbound\.displayInput,[\s\S]*?attachments:\s*editedAttachments\.length > 0/,
  'The edited optimistic bubble must keep attachment cards without exposing @ paths',
);
assert.match(
  hookSource,
  /const editedStreamAttachments = optimisticAttachments\.length > 0[\s\S]*?streamAttachmentsFromChatAttachments\([\s\S]*?editedAttachments/,
  'Editing only the text of an attached message must keep its original files in the rerun',
);

const apiSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'api.ts'),
  'utf8',
);
assert.doesNotMatch(apiSource, /runtime\.client\.supersedeSessionMessages\(/,
  'Edit preparation must not mutate the effective history');
assert.match(
  apiSource,
  /messageIds:\s*messages\s*\.slice\(supersedeFrom\)\s*\.map/,
);
assert.match(apiSource, /reason: 'user_edit_regenerate'/);
assert.match(
  apiSource,
  /const replacementTurnId = `turn_\$\{crypto\.randomUUID\(\)\}`/,
  'Update and rerun must allocate its replacement identity before superseding history',
);
assert.match(
  apiSource,
  /supersession = \{\s*expectedRevision: snapshot\.revision/,
  'Replacement admission must reject an edit based on stale history',
);
assert.match(
  apiSource,
  /streamRuntimeChat\([\s\S]{0,120}?userInput: content[\s\S]{0,120}?turnId: replacementTurnId, supersession/,
  'The rerun must carry its supersession in the replacement Turn request',
);
assert.match(
  apiSource,
  /markRuntimeSupersededMessages\(projected, superseded\)/,
  'History reads that retain audit rows must mark stale revisions before UI projection',
);
assert.doesNotMatch(apiSource, /method:\s*'PATCH'|truncate_after/);

const projectionSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'runtimeSessionMessageProjection.ts'),
  'utf8',
);
const projectionTranspiled = ts.transpileModule(projectionSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const projectionModule = { exports: {} };
vm.runInNewContext(projectionTranspiled.outputText, {
  module: projectionModule,
  exports: projectionModule.exports,
  Date,
  Set,
});
const { markRuntimeSupersededMessages } = projectionModule.exports;
const projectedRevisions = markRuntimeSupersededMessages([
  { id: 'old-user', messageId: 'old-user', role: 'user', content: '旧问题' },
  { id: 'new-user', messageId: 'new-user', role: 'user', content: '更新后的问题' },
], ['old-user']);
assert.equal(projectedRevisions[0].metadata.__bush_superseded, true);
assert.equal(projectedRevisions[1].metadata, undefined);

console.log('message edit and rerun contract tests passed');

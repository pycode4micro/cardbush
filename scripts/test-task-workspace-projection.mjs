import assert from 'node:assert/strict';
import path from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const modules = ['src/backend/workspaceReview.ts', 'src/backend/historyToolAssociation.ts',
  'src/features/tools/toolChangeReports.ts', 'src/features/chatMessages/transcript/toolExecutionMerge.ts'];
const { workspaceCheckpointExecutions, coverWorkspaceToolExecution, attachHistoryToolExecutions,
  changeReportsFromMessages, mergeToolExecutionUpdate } = await loadChatTranscript({
  source: modules.map(file => `export * from ${JSON.stringify(path.resolve(file))};`).join('\n'),
});
const change = path => ({ change_id: path, path, status: 'modified', additions: 1, deletions: 1,
  metadata: { diff: '@@ -1,1 +1,1 @@\n-before\n+after' } });
const native = { id: 'edit', name: 'edit_file', state: 'completed', turnId: 'one',
  assistantMessageId: 'assistant-one', success: true, durationMs: 1, sequence: 2,
  createdAt: '2026-09-06T00:00:00Z', metadata: { nativeResultDeferred: true,
    workspaceChangeDetailsDeferred: true, workspaceChanges: [change('file.txt')] } };
const review = { workspace: { sessionId: 'task', workspaceDir: 'D:/copy', sourceDir: 'D:/source' },
  checkpoints: [{ turnId: 'one', createdAt: native.createdAt, status: 'complete', changes: [change('file.txt'), change('shell.txt')] }] };
const before = JSON.stringify(native);
const covered = coverWorkspaceToolExecution(native, review);
assert.equal(covered.metadata.workspaceCheckpointCovered, true);
assert.equal(covered.metadata.workspaceChangeDetailsDeferred, false);
assert.equal(JSON.stringify(native), before, 'renderer projection cannot mutate native Tool facts');
const outside = { ...native, metadata: { ...native.metadata, workspaceChanges: [{ ...change('ignored/notes.txt'), metadata: { workspaceVersioned: false } }] } };
assert.equal(coverWorkspaceToolExecution(outside, review), outside, 'Git review cannot hide edits outside its actual coverage');
assert.equal(mergeToolExecutionUpdate(covered, native).metadata.workspaceCheckpointCovered, true, 'late detail must retain workspace coverage');
const messages = [{ id: 'user', role: 'user', content: 'change the project', turnId: 'one' },
  { id: 'assistant-one', role: 'assistant', content: 'editing', turnId: 'one' },
  { id: 'assistant-final', role: 'assistant', content: 'done', turnId: 'one' }];
const projected = attachHistoryToolExecutions(messages, [covered, ...workspaceCheckpointExecutions(review)]);
assert.equal(projected[1].toolExecutions[0].id, 'edit');
assert.equal(projected[2].toolExecutions[0].name, 'workspace_checkpoint');
const reports = changeReportsFromMessages(projected);
assert.equal(reports.length, 1, 'one workspace report replaces duplicate per-Tool change reports');
assert.equal(reports[0].fileCount, 2, 'shell-only modifications are included');
assert.equal(reports[0].detailsDeferred, false, 'checkpoint review never hydrates from a fabricated native Tool');
review.checkpoints[0].status = 'reverted';
assert.equal(changeReportsFromMessages(attachHistoryToolExecutions(projected, workspaceCheckpointExecutions(review))).length, 0);
review.checkpoints[0].status = 'failed';
assert.equal(workspaceCheckpointExecutions(review).length, 0, 'incomplete checkpoints cannot claim reversible changes');
assert.equal(coverWorkspaceToolExecution(native, review), native);
console.log('Task workspace projection passed: source facts, shell coverage, Turn association, hydration and revert state.');

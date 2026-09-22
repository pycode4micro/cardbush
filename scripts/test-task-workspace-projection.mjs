import assert from 'node:assert/strict';
import path from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const modules = ['src/backend/workspaceReview.ts', 'src/backend/historyToolAssociation.ts',
  'src/features/tools/toolChangeReports.ts', 'src/features/chatMessages/transcript/toolExecutionMerge.ts'];
const { workspaceCheckpointExecutions, coverWorkspaceToolExecution, markRevertedWorkspaceToolExecution, attachHistoryToolExecutions,
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
const revertedReports = changeReportsFromMessages(attachHistoryToolExecutions(projected, workspaceCheckpointExecutions(review)));
const revertedMessages = attachHistoryToolExecutions(projected, workspaceCheckpointExecutions(review));
assert.equal(revertedReports.length, 1, 'keep the record available for undo revert');
assert.equal(revertedReports[0].reverted, true);
assert.equal(revertedReports[0].id, reports[0].id, 'a revert never shifts review identities');
review.checkpoints[0].status = 'complete';
assert.equal(changeReportsFromMessages(attachHistoryToolExecutions(revertedMessages, workspaceCheckpointExecutions(review)))[0].reverted, undefined,
  'restoring must clear stale revert metadata when refreshed details merge into the transcript');
const revertedNative = markRevertedWorkspaceToolExecution(native, { revertedWorkspaceChangeIds: ['file.txt'] });
assert.equal(revertedNative.metadata.revert_status, 'reverted');
const restoredNative = markRevertedWorkspaceToolExecution(native, { revertedWorkspaceChangeIds: [] });
assert.equal(mergeToolExecutionUpdate(revertedNative, restoredNative).metadata.revert_status, 'active');
assert.equal(JSON.stringify(native), before, 'revert projection must not rewrite tool facts');
review.checkpoints[0].status = 'failed';
assert.equal(workspaceCheckpointExecutions(review).length, 0, 'incomplete checkpoints cannot claim reversible changes');
assert.equal(coverWorkspaceToolExecution(native, review), native);
const repeatedCallReports = changeReportsFromMessages([
  { id: 'first', role: 'assistant', content: 'first', turnId: 'one', toolExecutions: [native] },
  { id: 'second', role: 'assistant', content: 'second', turnId: 'two', toolExecutions: [{ ...native, turnId: 'two' }] },
  { id: 'duplicate', role: 'assistant', content: '', turnId: 'two', toolExecutions: [{ ...native, turnId: 'two' }] },
]);
assert.deepEqual(Array.from(repeatedCallReports, report => report.turnId), ['one', 'two'], 'tool call IDs are scoped to a turn; same-turn duplicates stay collapsed');
console.log('Task workspace projection passed: source facts, shell coverage, Turn association, hydration and revert state.');

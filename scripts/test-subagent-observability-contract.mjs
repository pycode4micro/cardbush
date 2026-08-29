import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const api = read('src', 'backend', 'api.ts');
const runtimeChat = read('src', 'backend', 'runtimeChat.ts');
const protocol = read('packages', 'bush-protocol', 'src', 'delegation.ts');
const hook = read('src', 'hooks', 'useCardbushChat.ts');
const summary = read('src', 'features', 'chat', 'ConversationWorkSummary.tsx');
const inspector = read('src', 'features', 'chat', 'WorkSummaryInspector.tsx');
const events = read('src', 'features', 'subagents', 'subagentObservabilityEvents.ts');
const app = read('src', 'App.tsx');

assert.match(runtimeChat, /record\.toolCall\.name === 'subagent'/);
assert.match(runtimeChat, /request\.onSubagentDispatch\?\.\(subagentDispatch\(record, event\)\)/);
assert.match(runtimeChat, /protocol: 'bush\.subagent_task\.v1'/);
assert.match(api, /runtime\.client\.listSubagentTasks\(/);
assert.match(api, /runtime\.client\.getSubagentTask\(\s*\{/);
assert.match(api, /session\.turns\.find\(\s*\(item\) => item\.turnId === normalizedTurnId/);
assert.doesNotMatch(api, /\/v1\/subagent-tasks|\/subagent-completions/);
assert.match(protocol, /BUSH_SUBAGENT_TASK_PROTOCOL = "bush\.subagent_task\.v1"/);
assert.match(hook, /emitSubagentDispatch/);
assert.match(events, /cardbush:subagent-dispatch/);

assert.match(summary, /fetchSubagentTasks/);
assert.doesNotMatch(summary, /fetchSubagentCompletions/);
assert.match(summary, /hasActiveTasks/);
assert.match(summary, /window\.setInterval\(refreshTaskFeed, hasActiveTasks \? 2500 : 10000\)/);
assert.match(summary, /subagentTaskIsNewer/);
assert.match(summary, /\['result_ready', 'completed'\]\.includes\(status\)/);
assert.match(summary, /left\.toolCallId && right\.toolCallId/);
assert.match(summary, /left\.taskId && right\.taskId/);
assert.match(summary, /data-testid="work-summary-subagents"/);
assert.match(summary, /subagentTaskPageSize = 3/);
assert.match(summary, /kind: 'turn-history'/);
assert.match(summary, /kind: 'subagent-task'/);

assert.match(inspector, /fetchSubagentTask/);
assert.match(inspector, /fetchTurnSnapshot/);
assert.match(inspector, /window\.setInterval\(refreshActiveTask, 2500\)/);
assert.match(inspector, /Complete raw details/);
assert.match(inspector, /task\.teamMemberId/);
assert.match(api, /teamMemberId: optionalString/);
assert.match(inspector, /Awaiting parent review/);
assert.match(inspector, /Service interrupted; task incomplete/);
assert.match(app, /OPEN_WORK_SUMMARY_INSPECTOR_EVENT/);
assert.match(app, /<WorkSummaryInspector/);
assert.match(app, /backendCapabilities\.subagentObservabilityProtocol ===\s*SUBAGENT_DISPATCH_EVENT_PROTOCOL/);

console.log('subagent observability contract tests passed');

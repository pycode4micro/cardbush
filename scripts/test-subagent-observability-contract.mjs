import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const api = read('src', 'backend', 'api.ts');
const hook = read('src', 'hooks', 'useCardbushChat.ts');
const summary = read('src', 'features', 'chat', 'ConversationWorkSummary.tsx');
const inspector = read('src', 'features', 'chat', 'WorkSummaryInspector.tsx');
const events = read('src', 'features', 'subagents', 'subagentObservabilityEvents.ts');
const app = read('src', 'App.tsx');

assert.match(api, /eventName === 'subagent_dispatch'/);
assert.match(api, /request\.onSubagentDispatch\?\./);
assert.match(api, /subagentDispatchEventFromPayload/);
assert.match(api, /event\.protocol === SUBAGENT_DISPATCH_EVENT_PROTOCOL/);
assert.match(api, /\/v1\/subagent-tasks\?*/);
assert.match(api, /\/v1\/subagent-tasks\/\$\{encodeURIComponent\(normalizedTaskId\)\}/);
assert.match(api, /\/subagent-completions/);
assert.match(api, /subagent_observability/);
assert.match(hook, /emitSubagentDispatch/);
assert.match(events, /cardbush:subagent-dispatch/);

assert.match(summary, /fetchSubagentTasks/);
assert.match(summary, /fetchSubagentCompletions/);
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
assert.match(inspector, /window\.setInterval\(refreshActiveTask, 2500\)/);
assert.match(inspector, /Complete raw details/);
assert.match(inspector, /Awaiting parent review/);
assert.match(inspector, /Service interrupted; task incomplete/);
assert.match(app, /OPEN_WORK_SUMMARY_INSPECTOR_EVENT/);
assert.match(app, /<WorkSummaryInspector/);
assert.match(app, /backendCapabilities\.subagentObservabilityProtocol ===\s*SUBAGENT_DISPATCH_EVENT_PROTOCOL/);

console.log('subagent observability contract tests passed');

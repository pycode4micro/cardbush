import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const projectionPath = path.join(
  process.cwd(),
  'src',
  'features',
  'composer',
  'thinkingNoticeProjection.ts',
);
const projectionSource = fs.readFileSync(projectionPath, 'utf8');
const transpiled = ts.transpileModule(projectionSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const projectionModule = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module: projectionModule,
  exports: projectionModule.exports,
});
const { createThinkingNoticeProjection } = projectionModule.exports;

const clock = fakeClock();
const commits = [];
const projection = createThinkingNoticeProjection(
  (notice) => commits.push(notice ? { ...notice } : null),
  { intervalMs: 120, scheduler: clock.scheduler },
);
projection.accept(thinking('start'));
for (let index = 0; index < 10_000; index += 1) {
  projection.accept(thinking('delta', 'x'));
}
assert.equal(commits.length, 1, 'the first reasoning delta should be visible immediately');
assert.equal(clock.pending(), 1, 'a burst must own at most one projection timer');
clock.advance(120);
assert.equal(commits.length, 2, 'ten thousand deltas should collapse into one trailing commit');
assert.equal(commits.at(-1).content.length, 10_000, 'batching must preserve every factual delta');

projection.accept(thinking('end'));
assert.equal(commits.at(-1), null, 'a matching terminal event must clear the live reasoning row');
assert.equal(clock.pending(), 0, 'terminal cleanup must remove the pending projection timer');

projection.accept(thinking('start', '', 'segment-2'));
assert.equal(commits.at(-1), null, 'a start event must not add an empty render');
projection.accept(thinking('delta', 'next', 'segment-2'));
assert.equal(commits.at(-1).content, 'next');
projection.dispose();
assert.equal(clock.pending(), 0, 'dispose must leave no external timer behind');

const messageProjectionPath = path.join(
  process.cwd(),
  'src',
  'features',
  'chatMessages',
  'messageRenderProjection.ts',
);
const messageProjectionSource = fs.readFileSync(messageProjectionPath, 'utf8');
const messageProjectionTranspiled = ts.transpileModule(messageProjectionSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const messageProjectionModule = { exports: {} };
vm.runInNewContext(messageProjectionTranspiled.outputText, {
  module: messageProjectionModule,
  exports: messageProjectionModule.exports,
});
const { projectRenderableChatMessages } = messageProjectionModule.exports;
const visibleOnly = [chatMessage('user', 'user-1'), chatMessage('assistant', 'assistant-1')];
assert.equal(
  projectRenderableChatMessages(visibleOnly),
  visibleOnly,
  'the render projection must preserve referential identity on its fast path',
);
const mixedHistory = [
  chatMessage('system', 'system-1'),
  chatMessage('user', 'user-1'),
  ...Array.from({ length: 523 }, (_, index) => chatMessage('tool', `tool-${index}`)),
  chatMessage('assistant', 'assistant-1'),
];
assert.deepEqual(
  Array.from(projectRenderableChatMessages(mixedHistory), (message) => message.role),
  ['user', 'assistant'],
  'model-only protocol rows must not allocate empty React message items',
);

const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'App.tsx'), 'utf8');
const hookSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'hooks', 'useCardbushChat.ts'),
  'utf8',
);
const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf8');
const apiSource = fs.readFileSync(path.join(process.cwd(), 'src', 'backend', 'api.ts'), 'utf8');
const runtimeHostSource = fs.readFileSync(
  path.join(process.cwd(), 'packages', 'bush-runtime', 'src', 'inMemoryRuntimeHost.ts'),
  'utf8',
);
const performanceTraceSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'shared', 'uiPerformanceTrace.ts'),
  'utf8',
);
const toolExecutionBlockSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'ToolExecutionBlock.tsx'),
  'utf8',
);
const toolChangeBlockSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'ToolChangeBlock.tsx'),
  'utf8',
);
const messageBubbleSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chatMessages', 'MessageBubble.tsx'),
  'utf8',
);
const styleSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'styles', 'app.css'),
  'utf8',
);

assert.doesNotMatch(
  appSource,
  /setThinkingNotice|\[thinkingNotice,\s*setThinkingNotice\]/,
  'reasoning deltas must not invalidate the application root',
);
assert.match(
  appSource,
  /<LiveComposerRuntimeRail[\s\S]*?activeConversationId=\{activeConversationId\}/,
  'live reasoning should be owned by the isolated runtime rail',
);
assert.equal(
  (hookSource.match(/if \(requestContext\.reasoningTraceVisible !== true\) return;/g) ?? []).length,
  3,
  'hidden reasoning must not allocate renderer CustomEvents in any stream path',
);
assert.match(
  appSource,
  /sessionStorage\.getItem\('cardbush_scroll_debug'\)/,
  'detailed scroll logging must expire when the GUI process exits',
);
assert.doesNotMatch(
  appSource,
  /localStorage\.getItem\('cardbush_scroll_debug'\)/,
  'a stale persistent debug flag must not keep high-frequency IPC logging enabled',
);
assert.match(
  mainSource,
  /const windowCompositionDebugEnabled =\s*process\.env\.CARDBUSH_WINDOW_COMPOSITION_DEBUG/,
  'capturePage diagnostics must require an explicit environment switch',
);
assert.doesNotMatch(
  mainSource,
  /const windowCompositionDebugEnabled =\s*!cardbushRuntimeIsPackaged/,
  'ordinary local GUI runs must not capture the window on focus and blur',
);
assert.match(
  mainSource,
  /wallpaperAccentCache\?\.signature === signature[\s\S]*?return wallpaperAccentCache\.value/,
  'periodic wallpaper refreshes must not decode an unchanged image again',
);
assert.match(
  appSource,
  /projectRenderableChatMessages\(activeTranscript\)/,
  'ChatPanel must remove nonvisual protocol rows before mapping React children',
);
assert.match(
  appSource,
  /setWallpaperAccent\(\(current\) =>[\s\S]*?current\?\.r === accent\.r[\s\S]*?\? current[\s\S]*?: accent/,
  'unchanged wallpaper polling must preserve state identity instead of rerendering the application root',
);
assert.match(
  appSource,
  /<MessageFileReferenceScope[\s\S]*?<div className="message-list-content">[\s\S]*?renderMessages\.map/,
  'file-reference context must be shared by the list instead of recreated per row',
);
assert.match(
  apiSource,
  /getConversationSession\(sessionId\)/,
  'history reads must request the transcript transport projection',
);
assert.match(
  apiSource,
  /listTurnToolExecutionSummaries/,
  'history reads must not eagerly transport native Tool results',
);
assert.match(
  toolExecutionBlockSource,
  /if \(!expanded \|\| !deferredExecutionKey\) return undefined;[\s\S]*?fetchRuntimeTurnToolExecutionDetails/,
  'native Tool results must load only after the user opens the execution disclosure',
);
assert.match(
  toolChangeBlockSource,
  /const canExpand = hasDetails \|\| detailsDeferred;[\s\S]*?onRequestDetails\?\.\(\)/,
  'a deferred Workspace Change must remain expandable and request its full diff on demand',
);
assert.match(
  runtimeHostSource,
  /messageProjection === "full"[\s\S]*?conversationSessionSnapshot/,
  'the Runtime must keep full reads as the default and project only explicit conversation reads',
);
assert.match(
  performanceTraceSource,
  /sessionStorage\.getItem\('cardbush_ui_performance_debug'\) === 'true'/,
  'diagnostic performance logging must require an explicit session-scoped switch',
);
assert.match(
  appSource,
  /runningConversationIds=\{chat\.processingConversationIds\}/,
  'the sidebar running marker must consume the submit-to-done lifecycle instead of live Turn details',
);
assert.match(
  appSource,
  /if \(chat\.processingConversationIds\.has\(conversationId\)\) continue;/,
  'sidebar change summaries must stay frozen while a Turn is producing live facts',
);
assert.match(
  messageBubbleSource,
  /function AssistantAtomicReveal[\s\S]*?getBoundingClientRect\(\)\.height/,
  'a complete assistant segment must reserve its measured layout before becoming visible',
);
assert.match(
  messageBubbleSource,
  /function AssistantAtomicReveal[\s\S]*?classList\.add\('is-visible'\)/,
  'the measured assistant segment must reveal without another React state update',
);
assert.doesNotMatch(
  styleSource,
  /\.message-row\.assistant\.streaming\s*\{[\s\S]*?min-height:\s*clamp/,
  'assistant layout reservation must use measured content rather than a fixed viewport-sized gap',
);

console.log('ui performance isolation contract tests passed');

function thinking(phase, delta = '', id = 'segment-1') {
  return {
    id,
    turnId: 'turn-1',
    phase,
    delta,
    createdAt: '2026-09-03T00:00:00.000Z',
  };
}

function chatMessage(role, id) {
  return { id, role, content: id, createdAt: '2026-09-03T00:00:00.000Z' };
}

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const scheduler = {
    now: () => now,
    setTimer(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
  };
  return {
    scheduler,
    pending: () => timers.size,
    advance(durationMs) {
      now += durationMs;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) return;
        timers.delete(due[0]);
        due[1].callback();
      }
    },
  };
}

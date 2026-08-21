import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const app = read('src', 'App.tsx');
const css = read('src', 'styles', 'app.css');
const presence = read('src', 'hooks', 'useSoftPanelPresence.ts');
const sidebar = read('src', 'features', 'sidebar', 'ChatSidebar.tsx');
const summary = read('src', 'features', 'chat', 'ConversationWorkSummary.tsx');
const workSummaryInspector = read('src', 'features', 'chat', 'WorkSummaryInspector.tsx');
const sidebarResizer = read('src', 'components', 'SidebarResizer.tsx');
const runtimeRail = read('src', 'features', 'composer', 'ComposerRuntimeRail.tsx');
const messageBubble = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');
const featureContent = read('src', 'features', 'panels', 'FeatureContentPanel.tsx');
const theme = read('src', 'styles', 'theme.css');

assert.match(messageBubble, /message-row assistant\$\{isActiveAssistantTurn \? ' streaming' : ''\}/);
assert.match(
  css,
  /\.message-row\.assistant\.streaming\s*\{[\s\S]*?min-height:\s*clamp\(132px,\s*22vh,\s*240px\)/,
  'The active assistant must reserve reading space before streamed Markdown arrives',
);

assert.match(css, /--panel-motion-duration:\s*240ms/);
assert.match(css, /--panel-motion-ease:/);
assert.match(css, /\.soft-panel-hidden\s*\{/);
assert.match(css, /\.sidebar\.soft-panel-hidden/);
assert.match(css, /\.right-inspector\.soft-panel-hidden/);
assert.match(css, /\.conversation-work-summary\.soft-panel-hidden/);
assert.match(css, /body\.sidebar-resizing \.sidebar[\s\S]*transition:\s*none/);
assert.match(css, /body\.right-inspector-resizing \.right-inspector[\s\S]*transition:\s*none/);
assert.match(css, /--chat-inline-gutter:\s*clamp\(12px,\s*3vw,\s*36px\)/);
assert.match(
  css,
  /--chat-track-width:\s*800px/,
  'Messages, composer, runtime cards, and welcome content must share a slightly narrower reading track',
);
assert.doesNotMatch(css, /--chat-track-width:\s*(787|672)px/);
assert.match(
  css,
  /\.error-banner,[\s\S]*?\.notice-banner\s*\{[\s\S]*?width:\s*min\(calc\(100% - 2 \* var\(--chat-inline-gutter\)\), var\(--chat-track-width\)\)/,
  'Conversation notices must align with the shared chat track instead of using an independent width',
);
assert.match(
  css,
  /@media \(max-width:\s*980px\)[\s\S]*?\.right-inspector\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?max-width:\s*calc\(100% - 48px\)/,
  'Narrow windows must overlay the inspector instead of squeezing the chat stage',
);
assert.match(css, /\.scene-body\.inspector-collapsed[\s\S]*42px/);
assert.doesNotMatch(css, /\.scene-inspector\.collapsed\s*\{\s*display:\s*none/);

assert.match(presence, /exitDurationMs\s*=\s*240/);
assert.match(presence, /setTimeout\([\s\S]*setMounted\(false\)/);
assert.match(presence, /prefers-reduced-motion/);
assert.match(app, /sidebarPresence\.mounted/);
assert.match(app, /inspectorPresence\.mounted/);
assert.match(app, /workSummaryPresence\.mounted/);
assert.doesNotMatch(
  app,
  /window\.innerWidth\s*<\s*1220[\s\S]{0,120}setSidebarCollapsed\(true\)/,
  'Opening or resizing the inspector must squeeze the chat stage without automatically hiding the left sidebar',
);
assert.match(app, /!showWorkSummary \|\| windowMaximized/);
assert.match(app, /target\.closest\('\.conversation-work-summary'\)/);
assert.match(app, /target\.closest\('\[data-work-summary-toggle\]'\)/);
assert.match(app, /data-work-summary-toggle/);
assert.match(app, /retainedInspectorContent/);
assert.match(app, /sidebarPreviewWidth/);
assert.match(app, /onResizeEnd=\{\(width, shouldCollapse\)/);
assert.match(sidebar, /soft-panel-motion/);
assert.match(summary, /soft-panel-motion/);
assert.match(summary, /const historyTurnPageSize = 3/);
assert.match(summary, /groupWorkSummaryHistoryByTurn\(messages\)/);
assert.match(summary, /historyGroups\.slice\(0, visibleHistoryTurnCount\)/);
assert.match(summary, /setVisibleHistoryTurnCount\(\(current\) => current \+ historyTurnPageSize\)/);
assert.match(summary, /kind: 'turn-history'/);
assert.match(summary, /openWorkSummaryInspector/);
assert.match(summary, /className="work-summary-history-turn"/);
assert.match(css, /\.work-summary-history-turn\s*\{/);
assert.match(workSummaryInspector, /<AssistantLoopHistoryBlock/);
assert.match(app, /<WorkSummaryInspector/);
assert.match(css, /\.work-summary-inspector\s*\{/);
assert.match(
  summary,
  /className="work-summary-section outputs"[\s\S]*?Tool activity[\s\S]*?data-testid="work-summary-history"[\s\S]*?className="work-summary-section work-summary-a2a-section"/,
  'Summary hierarchy must keep outputs first, tool activity second, history next, and A2A last',
);
assert.doesNotMatch(summary, /ShadowCloneIcon|ShadowTemporaryChat|work-summary-modes/);
assert.match(summary, /className="work-summary-a2a-toggle"[\s\S]*?aria-expanded=\{a2aExpanded\}/);
assert.doesNotMatch(
  css,
  /work-summary-hidden\) \.composer-shadow-chat-host\s*\{\s*display:\s*none/,
  'Removing Shadow from the summary must not hide the standalone composer Shadow chat',
);
assert.match(css, /\.conversation-work-summary\s*\{[\s\S]*?width:\s*336px/);
assert.match(css, /\.conversation-work-summary\s*\{[\s\S]*?border-radius:\s*22px/);
assert.match(sidebarResizer, /requestAnimationFrame/);
assert.match(sidebarResizer, /writePreviewWidth\(latest\.scope, latest\.pendingWidth\)/);
assert.match(sidebarResizer, /nextWidth < collapseSidebarWidthThreshold/);
assert.match(sidebarResizer, /shouldCollapseNow[\s\S]*?endResize\(\);[\s\S]*?onResizeEnd\?\.\(nextWidth, true\);[\s\S]*?onCollapse\?\.\(\)/);
assert.doesNotMatch(
  sidebarResizer,
  /handlePointerMove[\s\S]*?onWidthChange\(nextWidth\)/,
);
assert.match(runtimeRail, /useSoftPanelPresence\(Boolean\(activePanel\), 180\)/);
assert.match(runtimeRail, /panelPresence\.mounted/);
assert.match(runtimeRail, /context-visible/);
assert.doesNotMatch(css, /\.composer-runtime-rail\.expanded \.composer-runtime-tabs\s*\{\s*visibility:\s*hidden/);
assert.match(css, /\.composer-runtime-rail\.context-visible \.runtime-context-panel/);
assert.match(css, /\.composer-runtime-rail\.context-exiting \.runtime-context-panel/);
assert.match(messageBubble, /key=\{segment\.id\}/);
assert.doesNotMatch(messageBubble, /key=\{`\$\{segment\.id\}-\$\{index\}`\}/);
assert.match(
  css,
  /\.window-restored \.conversation-work-summary\.soft-panel-hidden[\s\S]*?translateY\(-8px\)/,
);
assert.match(
  css,
  /\.conversation-work-summary\.soft-panel-hidden[\s\S]*?translateX\(14px\)/,
  'Maximized summary must keep the existing right-side exit motion',
);
assert.match(featureContent, /className="tool-install-action-options"[\s\S]*?role="radiogroup"/);
assert.doesNotMatch(
  featureContent,
  /tool-install-form[\s\S]{0,300}<select/,
  'Short fixed action lists must not depend on an OS-native popup menu',
);
assert.match(
  css,
  /\.skill-detail-dialog\.tool-install-dialog\s*\{[\s\S]*?height:\s*auto;/,
  'Compact tool installation dialogs must override the fixed detail-dialog height',
);
assert.match(theme, /\.app\.theme-dark select,[\s\S]*?color-scheme:\s*dark/);
assert.match(theme, /\.app select option,[\s\S]*?background-color:\s*var\(--surface-strong\)/);

console.log('soft panel motion contract tests passed');

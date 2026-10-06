import { readSourceFile } from './helpers/read-source-file.cjs';
import { readAppViewSources } from './helpers/app-view-sources.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const read = (...parts) => readSourceFile(path.join(process.cwd(), ...parts), 'utf8');
const app = readAppViewSources();
const shadowWindow = read('src', 'ShadowWindow.tsx');
const css = read('src', 'styles', 'app.css');
const presence = read('src', 'hooks', 'useSoftPanelPresence.ts');
const sidebar = read('src', 'features', 'sidebar', 'ChatSidebar.tsx');
const summary = read('src', 'features', 'chat', 'ConversationWorkSummary.tsx');
const workSummaryInspector = read('src', 'features', 'chat', 'WorkSummaryInspector.tsx');
const sidebarResizer = read('src', 'components', 'SidebarResizer.tsx');
const rightInspectorResizer = read('src', 'components', 'RightInspectorResizer.tsx');
const rightInspectorSizing = read('src', 'components', 'rightInspectorSizing.ts');
const runtimeRail = read('src', 'features', 'composer', 'ComposerRuntimeRail.tsx');
const composer = read('src', 'features', 'composer', 'Composer.tsx');
const chatHook = read('src', 'hooks', 'useCardbushChat.ts');
const queueOrdering = read('src', 'features', 'composer', 'queueOrdering.ts');
const queueDrag = read('src', 'features', 'composer', 'useQueueReorder.ts');
const messageBubble = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');
const featureContent = read('src', 'features', 'panels', 'FeatureContentPanel.tsx');
const theme = read('src', 'styles', 'theme.css');

assert.match(messageBubble, /message-row assistant\$\{isActiveAssistantTurn \? ' streaming' : ''\}/);
assert.doesNotMatch(
  messageBubble,
  /AssistantAtomicReveal/,
  'accelerated stream chunks must render directly without a second hidden atomic phase',
);
assert.match(
  css,
  /\.assistant-response-spacer\s*\{[\s\S]*?height:\s*0;[\s\S]*?overflow-anchor:\s*none/,
  'response spacing must be isolated from message row geometry',
);
assert.doesNotMatch(
  css,
  /\.message-row\.assistant\.streaming\s*\{[\s\S]*?min-height:\s*clamp|assistant-atomic-reveal/,
  'the prepared stage must not revive the old unrelated row clamp or atomic flash',
);

assert.match(css, /--panel-motion-duration:\s*240ms/);
assert.match(css, /--panel-motion-ease:/);
assert.match(css, /\.soft-panel-hidden\s*\{/);
assert.match(css, /\.sidebar\.soft-panel-hidden/);
assert.match(css, /\.right-inspector\.soft-panel-hidden/);
assert.match(css, /\.conversation-work-summary\.soft-panel-hidden/);
assert.match(css, /body\.sidebar-resizing \.sidebar[\s\S]*transition:\s*none/);
assert.match(css, /body\.right-inspector-resizing \.right-inspector[\s\S]*transition:\s*none/);
assert.match(css, /--conversation-pane-min-width:\s*340px/);
assert.doesNotMatch(
  css,
  /\.desktop-shell\.window-maximized\s*\{[\s\S]*?--conversation-pane-min-width:/,
  'Window mode must not change the conversation minimum',
);
assert.match(
  css,
  /calc\(100cqw - 2px - var\(--layout-sidebar-space\)\)/,
  'The inspector can continuously shrink the conversation toward cover without switching positioning modes',
);
assert.match(
  rightInspectorResizer,
  /conversationPaneMinimum\(\s*windowMaximized,\s*window\.innerWidth/,
);
assert.match(
  rightInspectorResizer,
  /mainWidth \/ scaleX \+ currentWidth - minimumConversationPaneWidth/,
  'Pointer resizing must use the same narrower conversation-pane limit as the flex layout',
);
assert.match(rightInspectorSizing, /minimumConversationWidth = 340/);
assert.doesNotMatch(rightInspectorSizing, /maximizedInspectorMaximum/);
assert.match(
  rightInspectorSizing,
  /windowMaximized[\s\S]*?Math\.max\(minimumInspectorWidth, viewportWidth\)/,
  'A maximized inspector should use the available viewport instead of a fixed pixel ceiling',
);
assert.match(app, /<RightInspectorResizer[\s\S]*?windowMaximized=\{windowMaximized\}/);
assert.doesNotMatch(rightInspectorResizer, /minimumMainStageWidth\s*=\s*560/);
assert.match(app, /const inspectorWidthRef = useRef\(inspectorWidth\)/);
// Actual viewport fitting and preferred-width restoration are covered by the
// native inspector-window-layout fixture, including both window edges.
assert.doesNotMatch(app, /resizeInspectorFromWindowRightEdge/);
assert.match(css, /--chat-inline-gutter:\s*clamp\(18px,\s*calc\(3vw \+ 10px\),\s*46px\)/);
assert.match(
  css,
  /--chat-track-width:\s*704px/,
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
assert.match(presence, /prefersReducedMotion\(\)/);
assert.match(read('src', 'shared', 'motionPreference.ts'), /prefers-reduced-motion/);
assert.match(app, /sidebarPresence\.mounted/);
assert.match(app, /inspectorPresence\.mounted/);
assert.match(app, /workSummaryPresence\.mounted/);
assert.equal(
  (app.match(/className="right-inspector-tabs"/g) ?? []).length,
  1,
  'The inspector must render one shared tab strip instead of duplicating its active title',
);
assert.match(
  app,
  /<header className=\{`right-inspector-toolbar[\s\S]*?<InspectorTabStrip[\s\S]*?<\/header>/,
  'Browser and file tabs must live in the inspector title bar',
);
assert.match(read('src', 'features', 'inspector', 'inspectorTabs.ts'), /type InspectorTab = InspectorResourceTab \| InspectorReviewTab \| InspectorShadowTab/);
assert.match(app, /className="right-inspector-new-tab"/);
assert.match(app, /startPage=\{<InspectorActions \{\.\.\.inspectorActionProps\}/);
assert.match(app, /className="right-inspector-tab-strip"/);
assert.match(app, /useInspectorTabStrip\(activeInspectorTabIdentity, displayedInspectorTabs\.length\)/);
// Mount, wheel cancellation and ancestor-scroll behavior are exercised in Electron
// by test-inspector-tabs.cjs, rather than asserting the old buggy implementation.
assert.match(app, /className="right-inspector-tab-manager"/);
assert.match(app, /className="right-inspector-tab-menu" role="menu"/);
assert.match(app, /openInspectorTabContextMenu\(event, tab\.id\)/);
assert.match(app, /关闭其他标签页/);
assert.match(app, /关闭右侧标签页/);
assert.match(app, /关闭全部标签页/);
assert.match(
  app,
  /const inspectorActionProps = \{[\s\S]*?pickAttachments[\s\S]*?openShadowInspectorTab/,
  'The inspector start page must offer file and Shadow actions',
);
assert.match(app, /tab\.kind === 'review'[\s\S]*?<Clipboard/);
assert.match(app, /tab\.kind === 'shadow'[\s\S]*?<ShadowWindow embedded context=\{tab\.context\}/);
assert.match(app, /openInspectorTarget\(newBrowserTab\(language\)\)/);
assert.match(app, /className="right-inspector-address editable"[\s\S]*?\.navigate\(inspectorAddressDraft\)/);
assert.match(app, /const webviewDomReadyRef = useRef\(false\)/);
assert.match(app, /webview\.addEventListener\('dom-ready', ready\)/);
assert.match(
  app,
  /!webview\?\.isConnected \|\| !webviewDomReadyRef\.current/,
  'Inspector native methods must remain gated until the webview guest is attached and ready',
);
assert.match(
  app,
  /try \{[\s\S]*?webview\.loadURL\(destination\)[\s\S]*?\} catch \{/,
  'Inspector navigation must contain synchronous Electron webview lifecycle errors',
);
// Normal-scale wide pages and resizing are verified in real Electron by
// test-inspector-browser-navigation.cjs; fitting content into the panel is disabled.
for (const shortcut of ['openBrowser', 'openFiles', 'openShadow']) {
  assert.match(app, new RegExp(`item\\('${shortcut}'[^\\n]*actions\\.${shortcut}, '${shortcut}'`),
    'Inspector shortcuts and menu clicks must share the same application action');
}
assert.match(shadowWindow, /export function ShadowWindow\(\{/);
assert.match(shadowWindow, /shadow-inspector-shell/);
assert.doesNotMatch(css, /\.right-inspector-add-menu\s*\{/);
assert.match(css, /\.right-inspector-tab-menu\s*\{/);
assert.match(css, /\.right-inspector-tab-context-menu\s*\{/);
assert.match(css, /\.shadow-window-shell\.shadow-inspector-shell\s*\{/);
assert.match(css, /\.right-inspector-toolbar\.with-tabs\s*\{/);
assert.match(css, /\.right-inspector-toolbar\s*>\s*button\s*\{/);
assert.match(
  css,
  /\.right-inspector-tab\s*\{[\s\S]*?background:\s*var\(--surface\)/,
  'Inactive inspector tabs must blend into the title bar',
);
assert.match(
  css,
  /\.right-inspector-tab\.active\s*\{[\s\S]*?background:\s*var\(--right-inspector-active-tab-background\)/,
  'Only the active inspector tab should use the raised gray surface',
);
assert.doesNotMatch(
  app,
  /window\.innerWidth\s*<\s*1220[\s\S]{0,120}setSidebarCollapsed\(true\)/,
  'Opening or resizing the inspector must squeeze the chat stage without automatically hiding the left sidebar',
);
assert.match(app, /!showWorkSummary \|\| workSummaryDocked/);
assert.match(app, /target\.closest\('\.conversation-work-summary'\)/);
assert.match(app, /target\.closest\('\[data-work-summary-toggle\]'\)/);
assert.match(app, /target\.closest\('\[data-inspector-toggle\]'\)/);
assert.match(app, /target\.closest\('\.right-inspector'\)/);
assert.match(app, /data-work-summary-toggle/);
assert.match(app, /data-inspector-toggle/);
assert.match(
  app,
  /data-work-summary-toggle[\s\S]*?<Clipboard[\s\S]*?data-inspector-toggle[\s\S]*?<PanelRightOpen/,
  'The compact toolbar must place the summary before the far-right sidebar action',
);
assert.doesNotMatch(
  app,
  /<span>\{language === 'zh' \? '(?:摘要|审查)'/,
  'Summary and review toolbar controls must remain icon-only',
);
assert.doesNotMatch(app, /onToggleTerminal|ConsoleDock|consoleMode|终端控制台|Terminal console/);
assert.match(app, /--work-summary-anchor-right/);
assert.match(app, /bodyBounds\.right - toggleBounds\.right/);
assert.match(app, /onToggleWorkSummary\(event\.currentTarget\)/);
assert.match(app, /setWorkSummaryDocked\(bodyBounds\.width >= 1100\)/);
assert.match(app, /new ResizeObserver\(\(\) => updateWorkSummaryLayout\(\)\)/);
assert.match(
  app,
  /const showWorkSummary = workSummaryVisible;/,
  'The work summary must stay visible independently of the external inspector',
);
assert.doesNotMatch(
  app,
  /const showWorkSummary = workSummaryVisible && !inspectorOpen|if \(inspectorOpen\) \{\s*onCloseInspector\(\)/,
  'Opening the work summary must not close or be hidden by the external inspector',
);
assert.match(
  app,
  /const openChangeReview = useCallback\(\(filePath\?: string\) => \{\s*onOpenChangeReview\(filePath\);/,
  'Opening review must preserve the independently visible work summary',
);
assert.doesNotMatch(
  app,
  /inspectorSummaryOpen|setInspectorSummaryOpen|className="right-inspector-summary"/,
  'The inspector must not keep a duplicate change-count summary control',
);
assert.doesNotMatch(css, /\.right-inspector-summary\s*\{/);
assert.match(
  css,
  /\.conversation-work-summary\s*\{[\s\S]*?right:\s*var\(--work-summary-anchor-right, 12px\);[\s\S]*?top:\s*8px/,
  'Both layout modes must align the summary below the same toolbar button',
);
assert.match(
  css,
  /\.work-summary-docked\.work-summary-visible \.chat-content-frame\s*\{[\s\S]*?--work-summary-content-inset:\s*calc\(336px \+ var\(--work-summary-anchor-right, 12px\) \+ 12px\)/,
  'A docked summary must reserve its column without narrowing the scroll viewport',
);
assert.match(app, /const \[inspectorOpen, setInspectorOpen\] = useState\(false\)/);
assert.doesNotMatch(app, /sidebarPreviewWidth/);
assert.match(app, /<SidebarResizer\s+language=\{language\}\s+width=\{sidebarWidth\}/);
assert.match(sidebar, /soft-panel-motion/);
assert.match(summary, /soft-panel-motion/);
assert.doesNotMatch(summary, /work-summary-history-turn|historyTurnPageSize/);
assert.match(summary, /openWorkSummaryInspector/);
assert.match(workSummaryInspector, /<AssistantLoopHistoryBlock/);
assert.match(app, /<WorkSummaryInspector/);
assert.match(css, /\.work-summary-inspector\s*\{/);
assert.match(
  sidebar,
  /\{!embedded && \([\s\S]*?会话修改[\s\S]*?conversation\.title[\s\S]*?onClick=\{onClose\}/,
  'Embedded review must rely on the unified outer inspector title and close control',
);
assert.match(
  summary,
  /className="work-summary-section outputs"[\s\S]*?data-testid="work-summary-subagents"/,
  'Summary keeps outputs and subagent dispatches; execution history belongs to the turn',
);
assert.doesNotMatch(summary, /work-summary-tool-list|Tool activity|executions\.length/,
  'The redundant tool list and count are removed only from the summary');
assert.doesNotMatch(summary, /ShadowCloneIcon|ShadowTemporaryChat|work-summary-modes/);
assert.doesNotMatch(
  css,
  /work-summary-hidden\) \.composer-shadow-chat-host\s*\{\s*display:\s*none/,
  'Removing Shadow from the summary must not hide the standalone composer Shadow chat',
);
assert.match(css, /\.conversation-work-summary\s*\{[\s\S]*?width:\s*336px/);
assert.match(css, /\.conversation-work-summary\s*\{[\s\S]*?border-radius:\s*22px/);
assert.match(sidebarResizer, /requestAnimationFrame/);
assert.match(sidebarResizer, /writePreviewWidth\(latest\.scope, latest\.pendingWidth\)/);
assert.match(sidebarResizer, /nextWidth < panelCollapseWidth/);
assert.match(rightInspectorResizer, /nextWidth < panelCollapseWidth/);
assert.match(sidebarResizer, /shouldCollapseNow[\s\S]*?endResize\(\);[\s\S]*?onResizeEnd\?\.\(nextWidth, true\);[\s\S]*?onCollapse\?\.\(\)/);
assert.doesNotMatch(
  sidebarResizer,
  /handlePointerMove[\s\S]*?onWidthChange\(nextWidth\)/,
);
assert.match(runtimeRail, /useSoftPanelPresence\(queueOpen, 180\)/);
assert.match(runtimeRail, /panelPresence\.mounted/);
assert.match(runtimeRail, /context-visible/);
assert.match(runtimeRail, /className="runtime-screen-viewport"/);
assert.doesNotMatch(runtimeRail, /setTimeout|rollingToKind|screenKind|thinkingNotice|changeSummary|taskPlan|onCancelGoal/,
  'The composer rail is only a guidance queue, with no rotation or execution state');
assert.match(runtimeRail, /queuedMessageCount <= 0 && !queueLocked\) return null/,
  'An empty locked queue must keep its unlock control visible');
assert.match(runtimeRail, /queuedMessages\.map\(\(item, index\) =>/);
assert.match(runtimeRail, /guideQueuedMessage\(item\.id\)/);
assert.match(runtimeRail, /onEdit=\{onEditQueuedMessage \? \(\) => onEditQueuedMessage\(item\) : undefined\}/);
assert.match(runtimeRail, /onRemoveQueuedMessage\?\.\(item\.id\)/);
assert.match(runtimeRail, /className="runtime-screen-queue-actions"/);
assert.match(runtimeRail, /CornerDownLeft/);
assert.match(composer, /CornerDownLeft/);
assert.doesNotMatch(composer, /<Sparkles size=\{12\} \/>/);
assert.match(runtimeRail, /onPointerDown=\{\(event\) => queueDrag\.onPointerDown\(item\.id, event\)\}/,
  'The whole queue item initiates drag; interactive children are excluded by the drag hook');
assert.match(queueDrag, /setPointerCapture\(event\.pointerId\)/);
assert.match(runtimeRail, /data-queue-item-id=\{item\.id\}/);
assert.match(runtimeRail, /useQueueReorder\(queuedMessages, onReorderQueuedMessage/);
assert.match(chatHook, /reorderScopedQueue\([\s\S]*?queuedMessagesRef\.current/);
assert.match(app, /onReorderQueuedMessage=\{chat\.reorderQueuedMessage\}/);
assert.match(app, /onReorderQueuedMessage=\{onReorderQueuedMessage\}/);
assert.match(app, /\(queuedMessageCount > 0 \|\| queueLocked\) && \(\s*<ComposerRuntimeRail/);
assert.match(app, /onShowQueue=\{\(\) => runtimeRailRef\.current\?\.showQueue\(\)\}/);
assert.match(app, /<TurnRuntimeDetails/);
assert.match(css, /\.runtime-queue-list\s*\{[\s\S]*?scrollbar-gutter:\s*stable/);
assert.match(css, /\.composer-runtime-rail\.context-visible \.runtime-context-panel/);
assert.match(css, /\.composer-runtime-rail\.context-exiting \.runtime-context-panel/);
assert.match(css, /\.runtime-queue-list\s*\{[\s\S]*?overflow-y:\s*auto/);
assert.match(css, /\.runtime-queue-item\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
assert.match(css, /\.runtime-screen-queue-actions\s*\{[\s\S]*?position:\s*absolute[\s\S]*?right:\s*8px/);
assert.match(css, /\.composer-queue-actions\s*\{[\s\S]*?opacity:\s*1/);
assert.doesNotMatch(
  css,
  /\.composer-runtime-rail\.context-exiting \.runtime-screen-queue-actions/,
  'Collapsed queue actions must remain directly available.',
);

const queueOrderingJavaScript = ts.transpileModule(queueOrdering, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const { reorderScopedQueue } = await import(
  `data:text/javascript;base64,${Buffer.from(queueOrderingJavaScript).toString('base64')}`
);
const interleavedQueue = [
  { id: 'a1', conversationId: 'a' },
  { id: 'b1', conversationId: 'b' },
  { id: 'a2', conversationId: 'a' },
  { id: 'a3', conversationId: 'a' },
];
const idOf = (item) => item.id;
const scopeOf = (item) => item.conversationId;
assert.deepEqual(
  reorderScopedQueue(interleavedQueue, 'a3', 'a1', idOf, scopeOf).map(idOf),
  ['a3', 'b1', 'a1', 'a2'],
  'Reordering must preserve unrelated conversations while moving within the active queue.',
);
assert.deepEqual(
  reorderScopedQueue(interleavedQueue, 'a1', 'a3', idOf, scopeOf).map(idOf),
  ['a2', 'b1', 'a3', 'a1'],
  'Queue items must move both upward and downward.',
);
assert.equal(
  reorderScopedQueue(interleavedQueue, 'a1', 'b1', idOf, scopeOf),
  interleavedQueue,
  'Dragging across conversations must be ignored.',
);
assert.match(messageBubble, /key=\{segment\.id\}/);
assert.doesNotMatch(messageBubble, /key=\{`\$\{segment\.id\}-\$\{index\}`\}/);
assert.match(
  css,
  /\.work-summary-overlay \.conversation-work-summary\.soft-panel-hidden[\s\S]*?translateY\(-8px\)/,
);
assert.match(
  css,
  /\.conversation-work-summary\.soft-panel-hidden[\s\S]*?translateX\(14px\)/,
  'Docked summary must keep the existing right-side exit motion',
);
assert.doesNotMatch(featureContent, /tool-install|tool-manager/);
assert.doesNotMatch(css, /tool-install|tool-manager|tools-manager/);
assert.match(theme, /\.app\.theme-dark select,[\s\S]*?color-scheme:\s*dark/);
assert.match(theme, /\.app select option,[\s\S]*?background-color:\s*var\(--surface-strong\)/);

console.log('soft panel motion contract tests passed');

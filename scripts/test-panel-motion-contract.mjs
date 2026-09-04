import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const app = read('src', 'App.tsx');
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
  /\.message-list-item\.assistant-render-stage\s*\{[\s\S]*?--message-list-viewport-height[\s\S]*?--submitted-user-reading-anchor/,
  'the prepared response stage must derive from measured viewport geometry',
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
assert.match(css, /--conversation-pane-min-width:\s*440px/);
assert.match(
  css,
  /\.desktop-shell\.window-maximized\s*\{[\s\S]*?--conversation-pane-min-width:\s*clamp\(340px,\s*18vw,\s*440px\)/,
  'Only an actually maximized window may yield more horizontal space to the inspector',
);
assert.match(
  css,
  /calc\(100% - var\(--layout-sidebar-space\) - var\(--conversation-pane-min-width\)\)/,
  'The inspector width must preserve the shared conversation-pane minimum instead of a separate hard-coded limit',
);
assert.match(
  rightInspectorResizer,
  /conversationPaneMinimum\(\s*windowMaximized,\s*window\.innerWidth/,
);
assert.match(
  rightInspectorResizer,
  /mainWidth \+ currentWidth - minimumConversationPaneWidth/,
  'Pointer resizing must use the same narrower conversation-pane limit as the flex layout',
);
assert.match(rightInspectorSizing, /maximizedConversationPaneMinimum = 340/);
assert.match(rightInspectorSizing, /maximizedConversationPanePreferredRatio = 0\.18/);
assert.match(rightInspectorSizing, /maximizedConversationPaneMaximum = 440/);
assert.doesNotMatch(rightInspectorSizing, /maximizedInspectorMaximum/);
assert.match(
  rightInspectorSizing,
  /windowMaximized[\s\S]*?Math\.max\(minimumInspectorWidth, viewportWidth\)/,
  'A maximized inspector should use the available viewport instead of a fixed pixel ceiling',
);
assert.match(app, /<RightInspectorResizer[\s\S]*?windowMaximized=\{windowMaximized\}/);
assert.doesNotMatch(rightInspectorResizer, /minimumMainStageWidth\s*=\s*560/);
assert.match(app, /const inspectorWidthRef = useRef\(inspectorWidth\)/);
assert.match(app, /const rightEdgeDelta = nextLeft \+ nextOuterWidth/);
assert.match(app, /const leftEdgeStayedPut = Math\.abs\(nextLeft - previousLeft\) <= 2/);
assert.match(app, /Math\.sign\(innerWidthDelta\) !== Math\.sign\(rightEdgeDelta\)/);
assert.match(app, /pendingWidthDelta \+= innerWidthDelta/);
assert.match(app, /setInspectorWidth\(inspectorWidthRef\.current \+ widthDelta\)/);
assert.match(app, /window\.addEventListener\('resize', resizeInspectorFromWindowRightEdge\)/);
assert.match(app, /document\.body\.classList\.add\('window-right-edge-resizing'\)/);
assert.match(css, /body\.window-right-edge-resizing \.right-inspector,[\s\S]*?transition:\s*none/);
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
assert.equal(
  (app.match(/className="right-inspector-tabs"/g) ?? []).length,
  1,
  'The inspector must render one shared tab strip instead of duplicating its active title',
);
assert.match(
  app,
  /<header className=\{`right-inspector-toolbar[\s\S]*?className="right-inspector-tabs"[\s\S]*?<\/header>/,
  'Browser and file tabs must live in the inspector title bar',
);
assert.match(app, /type InspectorTab = InspectorResourceTab \| InspectorReviewTab \| InspectorShadowTab/);
assert.match(app, /className="right-inspector-add-tab"/);
assert.match(app, /className="right-inspector-add-menu" role="menu"/);
assert.match(
  app,
  /className="right-inspector-add-menu"[\s\S]*?pickAttachments[\s\S]*?openShadowInspectorTab[\s\S]*?openNewBrowserInspectorTab/,
  'The inspector new-tab menu must offer file, Shadow, and browser tabs in one place',
);
assert.match(app, /tab\.kind === 'review'[\s\S]*?<Clipboard/);
assert.match(app, /tab\.kind === 'shadow'[\s\S]*?<ShadowWindow embedded context=\{tab\.context\}/);
assert.match(app, /target: `about:blank\?cardbush-tab=\$\{crypto\.randomUUID\(\)\}`/);
assert.match(app, /className="right-inspector-address editable"[\s\S]*?\.navigate\(inspectorAddressDraft\)/);
assert.match(app, /handleInspectorShortcut[\s\S]*?key === 't'[\s\S]*?key === 'p'[\s\S]*?key === 's'/);
assert.match(shadowWindow, /export function ShadowWindow\(\{/);
assert.match(shadowWindow, /shadow-inspector-shell/);
assert.match(css, /\.right-inspector-add-menu\s*\{/);
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
assert.match(app, /!showWorkSummary \|\| windowMaximized/);
assert.match(app, /target\.closest\('\.conversation-work-summary'\)/);
assert.match(app, /target\.closest\('\[data-work-summary-toggle\]'\)/);
assert.match(app, /target\.closest\('\[data-change-review-toggle\]'\)/);
assert.match(app, /target\.closest\('\.right-inspector'\)/);
assert.match(app, /data-work-summary-toggle/);
assert.match(app, /data-change-review-toggle/);
assert.match(
  app,
  /data-change-review-toggle[\s\S]*?<PanelRightOpen[\s\S]*?data-work-summary-toggle[\s\S]*?<Clipboard/,
  'The compact toolbar must place review before the far-right summary action',
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
  /\.window-restored \.conversation-work-summary\s*\{[\s\S]*?top:\s*8px;[\s\S]*?right:\s*var\(--work-summary-anchor-right, 12px\)/,
  'Restored windows must anchor the summary below its toolbar button instead of presenting it as a right sidebar',
);
assert.match(
  css,
  /\.window-maximized\.work-summary-requested \.chat-content-frame\s*\{[\s\S]*?right:\s*328px/,
  'A maximized conversation must keep its summary indentation even while the external inspector is open',
);
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
  sidebar,
  /\{!embedded && \([\s\S]*?会话修改[\s\S]*?conversation\.title[\s\S]*?onClick=\{onClose\}/,
  'Embedded review must rely on the unified outer inspector title and close control',
);
assert.match(
  summary,
  /className="work-summary-section outputs"[\s\S]*?Tool activity[\s\S]*?data-testid="work-summary-history"/,
  'Summary hierarchy must keep outputs first, tool activity second, and history next',
);
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
assert.match(sidebarResizer, /nextWidth < collapseSidebarWidthThreshold/);
assert.match(sidebarResizer, /shouldCollapseNow[\s\S]*?endResize\(\);[\s\S]*?onResizeEnd\?\.\(nextWidth, true\);[\s\S]*?onCollapse\?\.\(\)/);
assert.doesNotMatch(
  sidebarResizer,
  /handlePointerMove[\s\S]*?onWidthChange\(nextWidth\)/,
);
assert.match(runtimeRail, /useSoftPanelPresence\(Boolean\(activePanel\), 180\)/);
assert.match(runtimeRail, /panelPresence\.mounted/);
assert.match(runtimeRail, /context-visible/);
assert.match(runtimeRail, /className="runtime-screen-viewport"/);
assert.match(runtimeRail, /setTimeout\([\s\S]*?5000/);
assert.match(runtimeRail, /setTimeout\([\s\S]*?420/);
assert.match(runtimeRail, /requestAnimationFrame\(\(\) => setReelAnimating\(true\)\)/);
assert.match(runtimeRail, /type RuntimeRailKind = RuntimeRailItem\['kind'\]/);
assert.match(runtimeRail, /const \[screenKind, setScreenKind\] = useState<RuntimeRailKind \| null>\(null\)/);
assert.match(runtimeRail, /railItems\.find\(\(item\) => item\.kind === screenKind\) \?\? railItems\[0\]/);
assert.match(runtimeRail, /current && availableRailKinds\.includes\(current\)/);
assert.match(
  runtimeRail,
  /\[\s*activePanel,\s*availableRailKinds,\s*priorityKind,\s*rollingToKind,\s*screenKind,?\s*\]/,
);
assert.doesNotMatch(
  runtimeRail,
  /\[activePanel, railItems, railKinds\]/,
  'Streaming label updates must not reset the runtime-screen rotation timer',
);
assert.doesNotMatch(
  runtimeRail,
  /screenIndex|setScreenIndex/,
  'Runtime-screen selection must survive item insertion and removal by kind, not array index',
);
assert.equal(
  (runtimeRail.match(/className=\{`composer-runtime-screen/g) ?? []).length,
  1,
  'Runtime state must render through one unified horizontal screen',
);
assert.doesNotMatch(runtimeRail, /composer-runtime-tabs|runtime-context-tab/);
assert.match(runtimeRail, /kind: 'processing' \| 'thinking' \| 'changes' \| 'queue'/);
assert.match(runtimeRail, /queuedMessageCount > 0/);
assert.match(runtimeRail, /renderedPanel === 'queue'/);
assert.match(runtimeRail, /queuedMessages\.map\(\(item, index\) =>/);
assert.match(runtimeRail, /guideQueuedMessage\(item\.id\)/);
assert.match(runtimeRail, /onEditQueuedMessage\?\.\(item\)/);
assert.match(runtimeRail, /onRemoveQueuedMessage\?\.\(item\.id\)/);
assert.match(runtimeRail, /previousQueuedMessageCountRef/);
assert.match(runtimeRail, /setPriorityKind\('queue'\)/);
assert.match(runtimeRail, /setRollingToKind\(priorityKind\)/);
assert.match(app, /currentTurnChangeSummary \|\| queuedMessageCount > 0/);
assert.match(app, /queuedMessageCount=\{0\}/);
assert.match(runtimeRail, /className=\{`runtime-screen-track \$\{reelAnimating \? 'rolling' : ''\}`\}/);
assert.match(runtimeRail, /<RuntimeScreenLine[\s\S]*?<RuntimeScreenLine/);
assert.doesNotMatch(css, /@keyframes runtime-screen-roll/);
assert.match(
  css,
  /\.runtime-screen-track\.rolling[\s\S]*?translateY\(-30px\)[\s\S]*?420ms/,
  'Runtime state changes must move through a continuous two-line reel',
);
assert.doesNotMatch(
  css,
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.runtime-screen-track\s*\{[\s\S]*?transition:\s*none !important/,
  'The functional status reel must not turn back into an instant content swap when Windows reduces decorative motion',
);
assert.match(
  css,
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.runtime-screen-track\.rolling\s*\{[\s\S]*?transition-duration:\s*420ms !important/,
  'The functional status reel must keep its hand-off duration when Windows reduces decorative motion',
);
assert.match(css, /\.composer-runtime-rail\.context-visible \.runtime-context-panel/);
assert.match(css, /\.composer-runtime-rail\.context-exiting \.runtime-context-panel/);
assert.match(css, /\.runtime-queue-list\s*\{[\s\S]*?overflow-y:\s*auto/);
assert.match(css, /\.runtime-queue-item\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/);
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
assert.doesNotMatch(featureContent, /tool-install|tool-manager/);
assert.doesNotMatch(css, /tool-install|tool-manager|tools-manager/);
assert.match(theme, /\.app\.theme-dark select,[\s\S]*?color-scheme:\s*dark/);
assert.match(theme, /\.app select option,[\s\S]*?background-color:\s*var\(--surface-strong\)/);

console.log('soft panel motion contract tests passed');

import { readAppViewSources } from './helpers/app-view-sources.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSource = readAppViewSources();
const styles = fs.readFileSync(path.join(process.cwd(), 'src', 'styles', 'app.css'), 'utf8');
const quickContextSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chat', 'QuickContextRail.tsx'),
  'utf8',
);
const backendApiSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'api.ts'),
  'utf8',
);
const chatScrollSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chatScroll.tsx'),
  'utf8',
);

assert.doesNotMatch(
  appSource,
  /react-virtuoso|<Virtuoso\b|scrollToIndex\(/,
  'The chat message list must not use virtualized height estimation',
);
assert.match(
  appSource,
  /const scrollToBottom = useCallback\(\(\) => \{[\s\S]*?jumpToLatestMessage\('scroll-bottom-button'\)/,
  'The visible bottom button must use the native-list jump path',
);
assert.match(
  appSource,
  /className="message-list"[\s\S]*?ref=\{setListScrollerRef\}[\s\S]*?className="message-list-content"[\s\S]*?renderMessages\.map\(\(message, index\)/,
  'All messages must render inside one native scroll container',
);
assert.match(
  appSource,
  /forceListToVisualBottom\(\);[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?strategy: 'native-message-list'/,
  'A bottom jump must settle the native list once after layout',
);
assert.match(
  appSource,
  /const markUserDetachedFromBottom = useCallback[\s\S]*?userDetachedFromBottomRef\.current = true;/,
  'An upward user gesture must detach stream following',
);
assert.match(
  appSource,
  /--composer-surface-center-x[\s\S]*?surfaceRect\.left \+ surfaceRect\.width \/ 2 - chatBodyRect\.left/,
  'The bottom button must use the measured composer center instead of viewport-centered pixels',
);
assert.match(
  appSource,
  /--composer-surface-top[\s\S]*?surfaceRect\.top - chatBodyRect\.top/,
  'The bottom button must use the measured composer top instead of a hard-coded bottom offset',
);
assert.match(
  appSource,
  /--composer-content-top[\s\S]*?visibleTop - chatBodyRect\.top/,
  'The bottom button must stay above the complete composer content, including runtime bars.',
);
assert.match(
  appSource,
  /const scheduleHeightUpdate = \(\) => \{[\s\S]*?requestAnimationFrame\([\s\S]*?updateHeight\(\)[\s\S]*?new ResizeObserver\(scheduleHeightUpdate\)/,
  'Composer geometry writes must run after ResizeObserver delivery instead of re-entering Blink layout',
);
assert.match(
  styles,
  /\.scroll-bottom\s*\{[\s\S]*?left:\s*var\(--composer-surface-center-x, 50%\);[\s\S]*?top:\s*calc\([\s\S]*?var\(--composer-content-top, var\(--composer-surface-top, 100%\)\)/,
);
assert.doesNotMatch(
  styles,
  /\.scroll-bottom\s*\{[^}]*(?:margin-left:\s*-20px|bottom:\s*max\(|-\s*46px)/,
  'The bottom button must not rely on the former hard-coded centering and vertical offsets',
);
assert.match(
  styles,
  /\.scroll-bottom\s*\{[\s\S]*?--scroll-bottom-size:\s*30px;[\s\S]*?width:\s*var\(--scroll-bottom-size\);[\s\S]*?height:\s*var\(--scroll-bottom-size\);[\s\S]*?color:\s*var\(--text\);/,
  'The scroll button hit target must not be an oversized transparent moving hotzone',
);
for (const label of [
  'trace-jump-start',
  'trace-scroll-event',
  'trace-composer-measure',
  'trace-outer-resize',
  'trace-outer-resize-follow',
]) {
  assert.match(
    appSource,
    new RegExp(label),
    `Scroll diagnostics must include ${label}`,
  );
}
assert.match(
  appSource,
  /const observed = \[[\s\S]*?mainStage,[\s\S]*?chatPanel,[\s\S]*?content,[\s\S]*?dockContent,[\s\S]*?\]\.filter/,
  'Outer diagnostics must observe every layout container that can change scroll geometry',
);
assert.match(
  appSource,
  /trace-outer-resize-follow[\s\S]*?scroller\.scrollTo\(\{[\s\S]*?top:\s*targetScrollTop,[\s\S]*?behavior:\s*gentleAutoFollowScrollBehavior\(\)/,
  'An outer layout change must ease toward the real bottom while automatic follow is active',
);
assert.match(
  appSource,
  /scrollBy\(\{[\s\S]*?top:\s*delta,[\s\S]*?behavior:\s*gentleAutoFollowScrollBehavior\(\)/,
  'Streaming content must ease into view instead of snapping the reading surface',
);
assert.match(
  appSource,
  /const desiredTop = Math\.round\([\s\S]*?scroller\.clientHeight \* 0\.07[\s\S]*?--submitted-user-reading-anchor[\s\S]*?behavior:\s*gentleAutoFollowScrollBehavior\(\)/,
  'A submitted user bubble must glide to a compact measured reading anchor below the title bar',
);
assert.match(
  styles,
  /\.message-list-item\.assistant-render-stage\s*\{[\s\S]*?min-height:\s*max\([\s\S]*?--message-list-viewport-height[\s\S]*?--quick-context-bottom-inset[\s\S]*?--submitted-user-reading-anchor/,
  'The active assistant must reserve the measured region between the reading anchor and composer',
);
assert.match(
  appSource,
  /setAssistantStageReservationActive\(shouldFollowSubmission\)[\s\S]*?sending &&\s*assistantStageReservationActive &&\s*message\.role === 'assistant'/,
  'The empty response stage must exist only for a submission that is still under automatic follow',
);
assert.match(
  appSource,
  /const releaseAssistantStageReservation = useCallback[\s\S]*?setAssistantStageReservationActive\(false\)[\s\S]*?if \(event\.deltaY !== 0\) \{\s*releaseAssistantStageReservation\(\)/,
  'Any manual wheel movement must release the synthetic response height instead of exposing blank scroll content',
);
assert.match(
  appSource,
  /classList\.contains\('assistant-render-stage'\)[\s\S]*?querySelector<HTMLElement>\('\.message-row\.assistant'\)/,
  'Automatic following must measure real assistant content instead of the reserved blank stage',
);
assert.match(
  chatScrollSource,
  /classList\.contains\('assistant-render-stage'\)[\s\S]*?querySelector<HTMLElement>\('\.message-row\.assistant'\)[\s\S]*?stagedContent \?\? item/,
  'Tail visibility must ignore the synthetic stage and measure only rendered assistant content',
);
assert.doesNotMatch(
  styles,
  /assistant-atomic-reveal|@keyframes assistant-stream-segment-enter/,
  'Released text must not be hidden behind a second atomic reveal or geometry animation',
);
assert.match(
  appSource,
  /pendingSubmittedUserEntryUntilRef[\s\S]*?user-message-entering/,
  'Only a freshly submitted user message should receive the entry animation class',
);
assert.match(
  styles,
  /\.message-list-item\.user-message-entering \.user-bubble[\s\S]*?animation:\s*user-message-enter 220ms/,
  'A submitted user bubble should enter with a short, low-impact transition',
);
assert.match(
  styles,
  /@keyframes user-message-enter[\s\S]*?opacity:\s*0\.82[\s\S]*?translateY\(4px\)/,
);
assert.match(
  styles,
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.message-list-item\.user-message-entering \.user-bubble/,
  'The user-message entry transition must respect reduced-motion preferences',
);
assert.match(
  appSource,
  /cardbushPreserveScroll[\s\S]*?userDetachedFromBottomRef\.current[\s\S]*?!autoFollowStreamRef\.current/,
  'Outer resize correction must not override explicit user or disclosure scrolling',
);
assert.match(
  appSource,
  /window\.__cardbushScrollDebug[\s\S]*?console\.debug\('\[cardbush:scroll\]'/,
  'Scroll diagnostics must be available both in memory and in the console',
);
assert.match(
  appSource,
  /traceId:[\s\S]*?scrollHeight:[\s\S]*?clientHeight:[\s\S]*?composerRect:[\s\S]*?footerRect:[\s\S]*?buttonRect:/,
  'Each scroll trace must correlate internal scroll metrics with outer geometry',
);
assert.match(
  appSource,
  /scrollbarInset = Math\.max\(0, scroller\.offsetWidth - scroller\.clientWidth\)[\s\S]*?--message-list-scrollbar-inset/,
  'Composer alignment must account for the native scrollbar width reported by the actual message viewport',
);
assert.match(
  appSource,
  /<\/div>\s*<button\s*ref=\{setScrollBottomRef\}/,
  'The bottom control must live outside the transitioning chat-content-frame',
);
assert.match(
  styles,
  /\.chat-panel \.composer-dock\s*\{\s*right:\s*var\(--message-list-scrollbar-inset, 0px\);/,
  'The composer content track must align with the real message viewport on every platform',
);
assert.doesNotMatch(
  styles,
  /\.chat-panel\.window-restored \.message-list\s*\{[^}]*height:/,
  'A restored window must not create a separate blank viewport above the composer',
);
assert.match(
  styles,
  /\.message-list-footer\s*\{[\s\S]*?var\(--quick-context-bottom-inset, var\(--composer-dock-height, 0px\)\)/,
  'The message tail must align with the visible composer surface, excluding its transparent gradient',
);
assert.match(
  styles,
  /\.scroll-bottom\s*\{[\s\S]*?--composer-surface-center-x[\s\S]*?--composer-content-top/,
  'The bottom control must align to the measured composer content boundary',
);
assert.match(
  quickContextSource,
  /querySelectorAll<HTMLElement>\('\[data-message-role="user"\]'\)[\s\S]*?readingAnchor[\s\S]*?setVisibleUserMessageId/,
  'The context rail must derive its current turn from user messages at the viewport reading anchor',
);
assert.match(
  quickContextSource,
  /resizeObserver\.observe\(content\)/,
  'The context rail must follow streamed content height changes',
);
assert.match(
  quickContextSource,
  /scroller\.addEventListener\('scroll', updateVisibleTurn/,
  'The context rail must follow viewport scrolling',
);
assert.match(
  quickContextSource,
  /const jumpToSelectedTurn = \(\) => \{[\s\S]*?data-message-id[\s\S]*?scroller\.scrollTo\([\s\S]*?behavior:/,
  'Turn details must provide a real jump back to the source message',
);
assert.match(quickContextSource, /跳转到该轮/);
const contextRailStyles = styles.slice(
  styles.indexOf('.quick-context-rail {'),
  styles.indexOf('.quick-context-pre-test-header {'),
);
assert.match(
  contextRailStyles,
  /\.quick-context-popovers\s*\{[\s\S]*?--quick-context-bottom-inset/,
  'Context previews must share the measured composer boundary',
);
assert.doesNotMatch(
  contextRailStyles,
  /100vw|58vh/,
  'Preview sizes must use the conversation region, not the entire window across an inspector',
);
assert.match(
  contextRailStyles,
  /max-height:\s*min\(460px, 100%\)/,
  'A short conversation must bound the preview height',
);
assert.match(
  contextRailStyles,
  /\.quick-context-turn\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto/,
  'Preview content must shrink and scroll without clipping its header or footer',
);
assert.match(quickContextSource, /--quick-context-preview-top/);
assert.match(
  quickContextSource,
  /fetchSessionTurnMessages\(\{[\s\S]*?sessionId,[\s\S]*?messageId: match\.serverMessageId/,
  'Quick Turn details must fetch the complete committed Turn instead of a truncated message window',
);
assert.doesNotMatch(
  quickContextSource,
  /fetchSessionMessageWindow|after:\s*12/,
  'Quick Turn details must not depend on a fixed-size message window',
);
assert.match(
  quickContextSource,
  /function quickTurnPreviewMessages[\s\S]*?message\.role === 'user'[\s\S]*?!isTurnGuidanceMessage[\s\S]*?transcript_kind === 'assistant_final'[\s\S]*?\.reverse\(\)\.find/,
  'Quick Turn details must render the user request and protocol-marked final assistant reply, with a legacy fallback',
);
assert.match(
  quickContextSource,
  /previewMessages\.map\(\(message\)[\s\S]*?<MarkdownContent content=\{message\.content\}/,
  'Quick Turn details must reuse the main chat Markdown renderer for the compact final projection',
);
assert.doesNotMatch(
  quickContextSource,
  /selectedTurnMessages\.map\(/,
  'Quick Turn details must not render raw tool and intermediate-loop messages',
);
assert.match(
  backendApiSource,
  /export async function fetchSessionTurnMessages[\s\S]*?snapshot\?\.turns\.find[\s\S]*?projectRuntimeTurnMessages/,
  'The backend must project the complete stored Turn through the standard chat projection protocol',
);
assert.doesNotMatch(
  quickContextSource,
  /filter\(\(message\) => message\.role === 'user'\)\.slice\(/,
  'The context rail must not discard older loaded user turns',
);
assert.match(
  quickContextSource,
  /Math\.max\(8, Math\.min\(96, Math\.floor\(availableHeight \/ 9\)\)\)/,
  'The context rail must cap rendered ticks to the available physical height',
);
assert.match(
  quickContextSource,
  /visibleRailTurns = railTurns\.slice\([\s\S]*?railWindowStart[\s\S]*?railCapacity/,
  'The context rail must render a bounded logical window without moving the rail container',
);
assert.match(
  quickContextSource,
  /onWheel=\{\(event\)[\s\S]*?scrollRailWindow\(event\.deltaY\)/,
  'Dense context rails must support windowed wheel navigation',
);
const contextTickTrackRule = styles.match(
  /\.quick-context-ticks\s*\{([^}]*)\}/,
)?.[1] ?? '';
assert.match(contextTickTrackRule, /top:\s*50%/);
assert.match(contextTickTrackRule, /transform:\s*translateY\(-50%\)/);
assert.doesNotMatch(
  contextTickTrackRule,
  /overflow-y:\s*auto/,
  'The tick track must retain its original centered geometry instead of becoming a scroll container',
);
assert.match(
  quickContextSource,
  /panelView !== 'closed'[\s\S]*?className=\{`quick-context-tick\$\{isCurrentTurn \? ' current'/,
  'Closed rails must reserve emphasis for the visible user turn',
);
assert.match(styles, /\.quick-context-tick\.current::before\s*\{/);
const currentTickRule = styles.match(
  /\.quick-context-tick\.current::before\s*\{([^}]*)\}/,
)?.[1] ?? '';
assert.match(currentTickRule, /background:/);
assert.doesNotMatch(
  currentTickRule,
  /(?:width|height|box-shadow)\s*:/,
  'The visible turn must differ by color only, without a larger or glowing tick',
);

console.log('chat scroll contract tests passed');

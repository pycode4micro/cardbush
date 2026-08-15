import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'App.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(process.cwd(), 'src', 'styles', 'app.css'), 'utf8');
const quickContextSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chat', 'QuickContextRail.tsx'),
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
  styles,
  /\.scroll-bottom\s*\{[\s\S]*?left:\s*var\(--composer-surface-center-x, 50%\);[\s\S]*?top:\s*calc\([\s\S]*?var\(--composer-surface-top, 100%\)/,
);
assert.doesNotMatch(
  styles,
  /\.scroll-bottom\s*\{[^}]*(?:margin-left:\s*-20px|bottom:\s*max\(|-\s*46px)/,
  'The bottom button must not rely on the former hard-coded centering and vertical offsets',
);
assert.match(
  styles,
  /\.scroll-bottom\s*\{[\s\S]*?--scroll-bottom-size:\s*40px;[\s\S]*?width:\s*var\(--scroll-bottom-size\);[\s\S]*?height:\s*var\(--scroll-bottom-size\);/,
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
  /trace-outer-resize-follow[\s\S]*?scroller\.scrollTop = targetScrollTop/,
  'An outer layout change must restore the real bottom while automatic follow is active',
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
  /\.chat-panel:not\(\.os-chat-panel\) \.composer-dock\s*\{\s*right:\s*var\(--message-list-scrollbar-inset, 0px\);/,
  'The composer content track must align with the real message viewport on every platform',
);
assert.doesNotMatch(
  styles,
  /\.chat-panel\.window-restored:not\(\.os-chat-panel\) \.message-list\s*\{[^}]*height:/,
  'A restored window must not create a separate blank viewport above the composer',
);
assert.match(
  styles,
  /\.message-list-footer\s*\{[\s\S]*?var\(--quick-context-bottom-inset, var\(--composer-dock-height, 0px\)\)/,
  'The message tail must align with the visible composer surface, excluding its transparent gradient',
);
assert.match(
  styles,
  /\.scroll-bottom\s*\{[\s\S]*?--composer-surface-center-x[\s\S]*?--composer-surface-top/,
  'The bottom control must align to the measured composer surface',
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

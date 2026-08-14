import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const app = read('src', 'App.tsx');
const css = read('src', 'styles', 'app.css');
const presence = read('src', 'hooks', 'useSoftPanelPresence.ts');
const sidebar = read('src', 'features', 'sidebar', 'ChatSidebar.tsx');
const summary = read('src', 'features', 'chat', 'ConversationWorkSummary.tsx');
const sidebarResizer = read('src', 'components', 'SidebarResizer.tsx');

assert.match(css, /--panel-motion-duration:\s*240ms/);
assert.match(css, /--panel-motion-ease:/);
assert.match(css, /\.soft-panel-hidden\s*\{/);
assert.match(css, /\.sidebar\.soft-panel-hidden/);
assert.match(css, /\.right-inspector\.soft-panel-hidden/);
assert.match(css, /\.conversation-work-summary\.soft-panel-hidden/);
assert.match(css, /body\.sidebar-resizing \.sidebar[\s\S]*transition:\s*none/);
assert.match(css, /body\.right-inspector-resizing \.right-inspector[\s\S]*transition:\s*none/);
assert.match(css, /\.scene-body\.inspector-collapsed[\s\S]*42px/);
assert.doesNotMatch(css, /\.scene-inspector\.collapsed\s*\{\s*display:\s*none/);

assert.match(presence, /exitDurationMs\s*=\s*240/);
assert.match(presence, /setTimeout\([\s\S]*setMounted\(false\)/);
assert.match(presence, /prefers-reduced-motion/);
assert.match(app, /sidebarPresence\.mounted/);
assert.match(app, /inspectorPresence\.mounted/);
assert.match(app, /workSummaryPresence\.mounted/);
assert.match(app, /retainedInspectorContent/);
assert.match(app, /sidebarPreviewWidth/);
assert.match(app, /onResizeEnd=\{\(width, shouldCollapse\)/);
assert.match(sidebar, /soft-panel-motion/);
assert.match(summary, /soft-panel-motion/);
assert.match(sidebarResizer, /requestAnimationFrame/);
assert.match(sidebarResizer, /writePreviewWidth\(latest\.scope, latest\.pendingWidth\)/);
assert.match(sidebarResizer, /nextWidth < collapseSidebarWidthThreshold/);
assert.match(sidebarResizer, /shouldCollapseNow[\s\S]*?endResize\(\);[\s\S]*?onResizeEnd\?\.\(nextWidth, true\);[\s\S]*?onCollapse\?\.\(\)/);
assert.doesNotMatch(
  sidebarResizer,
  /handlePointerMove[\s\S]*?onWidthChange\(nextWidth\)/,
);

console.log('soft panel motion contract tests passed');

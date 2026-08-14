import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const sidebarSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'sidebar', 'ChatSidebar.tsx'),
  'utf8',
);
const stylesSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'styles', 'app.css'),
  'utf8',
);
const rightInspectorResizerSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'components', 'RightInspectorResizer.tsx'),
  'utf8',
);

assert.match(
  sidebarSource,
  /className="section-action"[\s\S]*?event\.currentTarget\.blur\(\)/,
  'Mouse activation must not leave section actions visibly focused',
);
assert.match(
  sidebarSource,
  /className="conversation-more"[\s\S]*?event\.currentTarget\.blur\(\)/,
  'Mouse activation must not leave conversation actions visibly focused',
);
assert.doesNotMatch(
  stylesSource,
  /\.section-header:focus-within \.section-action/,
  'Pointer focus must not pin the section action after hover ends',
);
assert.match(
  stylesSource,
  /\.section-header:has\(\.section-action:focus-visible\)/,
  'Keyboard focus must continue to reveal the section action',
);
assert.match(sidebarSource, /aria-label=\{actionLabel\}/);
assert.match(
  stylesSource,
  /\.row-new-chat,\s*\.row-more,\s*\.conversation-more\s*\{[\s\S]*?top:\s*0;[\s\S]*?bottom:\s*0;[\s\S]*?margin-block:\s*auto;/,
  'Sidebar row actions must be centered without a transform that the global active state can overwrite',
);
assert.doesNotMatch(
  stylesSource,
  /\.row-new-chat,\s*\.row-more,\s*\.conversation-more\s*\{[^}]*translateY\(-50%\)/,
  'Sidebar row actions must not jump when the global button press scale is applied',
);
assert.match(
  rightInspectorResizerSource,
  /readCurrentInspectorWidth\(scope, width\)/,
  'Right inspector resizing must start from its rendered width, matching the sidebar',
);
assert.match(
  rightInspectorResizerSource,
  /requestAnimationFrame\([\s\S]*?writePreviewWidth/,
  'Right inspector pointer movement must update a CSS preview at most once per frame',
);
assert.match(
  rightInspectorResizerSource,
  /handlePointerUp[\s\S]*?onWidthChange\(finalWidth\)/,
  'Right inspector width must only be committed when the drag ends',
);
assert.match(
  rightInspectorResizerSource,
  /pointercancel[\s\S]*?handlePointerCancel/,
  'Right inspector resizing must restore its starting width when pointer input is cancelled',
);
assert.match(
  stylesSource,
  /\.right-inspector-resizer\s*\{[\s\S]*?left:\s*-4px;[\s\S]*?width:\s*8px;[\s\S]*?cursor:\s*ew-resize;/,
  'Right inspector resize hit area must align with the left sidebar resize handle',
);

console.log('sidebar interaction contract tests passed');

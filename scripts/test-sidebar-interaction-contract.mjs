import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const sidebarSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'sidebar', 'ChatSidebar.tsx'),
  'utf8',
);
const appSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'App.tsx'),
  'utf8',
);
const chatHookSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'hooks', 'useCardbushChat.ts'),
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
assert.match(
  stylesSource,
  /\.nav-row:focus-visible,[\s\S]*?outline:\s*2px solid color-mix\(in srgb, var\(--accent\) 34%, transparent\)/,
  'Primary navigation must use the shared theme focus ring instead of the browser default outline',
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
assert.doesNotMatch(
  stylesSource,
  /\.window-frame[^}]*cursor:\s*ew-resize/,
  'The internal split-resizer treatment must not replace native window resizing',
);
const windowGlyphRule = stylesSource.match(/\.window-glyph\s*\{([^}]*)\}/)?.[1] ?? '';
assert.match(stylesSource, /\.window-button\s*\{\s*width:\s*40px;[\s\S]*?height:\s*29px/);
assert.match(windowGlyphRule, /width:\s*10px/);
assert.match(windowGlyphRule, /height:\s*10px/);
assert.match(
  stylesSource,
  /\.window-button:hover\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--text\) 9%, transparent\)/,
  'Native window controls must use a neutral Windows-style hover surface',
);
assert.match(stylesSource, /\.window-button\.danger:hover\s*\{[\s\S]*?background:\s*#c42b1c/);
assert.match(
  appSource,
  /label=\{language === 'zh' \? '插件' : 'Plugins'\}[\s\S]*?插件管理[\s\S]*?工具管理[\s\S]*?技能管理/,
  'The native title bar must group plugin, tool, and skill management together',
);
assert.match(
  appSource,
  /label="Beta"[\s\S]*?label="OS"[\s\S]*?label="Team"/,
  'Experimental OS and Team surfaces must live under the Beta menu',
);
const windowFrameMenuBlock = appSource.match(
  /function WindowFrameMenu\([\s\S]*?function WindowFrameMenuItem/,
)?.[0] ?? '';
assert.doesNotMatch(
  windowFrameMenuBlock,
  /<ChevronDown/,
  'The title-bar menus must not show redundant expansion arrows',
);
assert.doesNotMatch(
  sidebarSource,
  /onSectionChange\('(os|skills|tools|team)'\)/,
  'OS, Team, tools, and skills must not remain duplicated in primary sidebar navigation',
);
assert.match(sidebarSource, /title=\{language === 'zh' \? '置顶' : 'Pinned'\}/);
assert.match(sidebarSource, /cardbush_pinned_conversation_ids/);
assert.match(sidebarSource, /pinnedProjects\.map\(renderProjectBlock\)/);
assert.match(sidebarSource, /pinnedConversations\.map\(renderStandaloneConversation\)/);
assert.match(sidebarSource, /options\.pinned[\s\S]*?取消置顶[\s\S]*?置顶对话/);
assert.match(stylesSource, /\.window-frame-menu-popover\s*\{/);
assert.doesNotMatch(
  sidebarSource,
  /title=\{language === 'zh' \? '对话' : 'Conversations'\}/,
  'The standalone conversation section must be removed from the sidebar',
);
const sidebarIconRule = stylesSource.match(
  /\.nav-row-icon,\s*\.project-row-icon\s*\{([^}]*)\}/,
)?.[1] ?? '';
assert.match(sidebarIconRule, /background:\s*transparent/);
assert.match(sidebarIconRule, /border:\s*0/);
assert.match(
  stylesSource,
  /--sidebar-tree-child:\s*calc\([\s\S]*?var\(--sidebar-tree-base\)[\s\S]*?var\(--sidebar-project-icon-size\)[\s\S]*?var\(--sidebar-tree-gap\)[\s\S]*?\)/,
  'Nested conversation text must share the exact project-title alignment column',
);
assert.match(stylesSource, /\.project-row\s*\{[\s\S]*?gap:\s*var\(--sidebar-tree-gap\)/);
assert.match(stylesSource, /\.conversation-row\.nested\s*\{[\s\S]*?padding-left:\s*var\(--sidebar-tree-child\)/);
assert.match(appSource, /cardbush_recent_project_dir/);
assert.match(
  appSource,
  /projectDir === undefined[\s\S]*?fallbackProjectDir \|\| undefined[\s\S]*?chat\.startConversation\(resolvedProjectDir\)/,
  'New chat must default to the most recently used available project',
);
assert.match(appSource, /function WelcomeProjectSwitcher\(/);
assert.match(appSource, /placeholder=\{language === 'zh' \? '搜索项目' : 'Search projects'\}/);
assert.match(appSource, /不在项目中工作/);
assert.match(
  appSource,
  /className="welcome-input-stack"[\s\S]*?<WelcomeProjectSwitcher[\s\S]*?\{welcomeComposer\}/,
  'The project context rail must be physically joined above the welcome composer',
);
assert.match(chatHookSource, /updateConversation\(\{[\s\S]*?projectDir: normalizedProjectDir \?\? null/);
assert.match(stylesSource, /\.welcome-project-switcher\s*\{/);
assert.match(stylesSource, /\.welcome-input-stack\s*\{[\s\S]*?margin:\s*0 auto/);
assert.match(
  stylesSource,
  /\.welcome-input-stack \.composer-surface,[\s\S]*?border-radius:\s*16px/,
  'The inset project rail must join a fully rounded welcome composer',
);
assert.match(
  stylesSource,
  /\.welcome-project-switcher\s*\{[\s\S]*?width:\s*calc\(100% - 30px\)[\s\S]*?margin:\s*0 15px -1px[\s\S]*?border-radius:\s*16px 16px 0 0/,
  'The project rail must be inset and visually joined to the welcome composer',
);
assert.match(appSource, /className="welcome-hero-logo" src="\.\/cardbush-logo\.png"/);
assert.doesNotMatch(appSource, /<u>\{selectedProjectDir/);

console.log('sidebar interaction contract tests passed');

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
const conversationWorkspaceSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'conversationWorkspace.ts'),
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
const windowDragRule = stylesSource.match(/\.window-drag\s*\{([^}]*)\}/)?.[1] ?? '';
const windowSpacerRule = stylesSource.match(/\.window-spacer\s*\{([^}]*)\}/)?.[1] ?? '';
const noDragRule = stylesSource.match(
  /\.no-drag,\s*button,\s*select,\s*input,\s*textarea\s*\{([^}]*)\}/,
)?.[1] ?? '';
assert.match(windowDragRule, /app-region:\s*drag/);
assert.match(windowDragRule, /-webkit-app-region:\s*drag/);
assert.match(windowSpacerRule, /min-width:\s*48px/);
assert.match(windowSpacerRule, /height:\s*100%/);
assert.match(windowSpacerRule, /app-region:\s*drag/);
assert.match(noDragRule, /app-region:\s*no-drag/);
assert.match(
  appSource,
  /className="window-spacer window-drag" aria-hidden="true"/,
  'The empty center title-bar area must remain an explicit native drag target',
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
  /label=\{language === 'zh' \? '插件' : 'Plugins'\}[\s\S]*?插件管理[\s\S]*?技能管理/,
  'The native title bar must group plugin and skill management together',
);
assert.doesNotMatch(appSource, /工具管理|Tool management/);
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
assert.match(sidebarSource, /className=\{`only-talk-toggle\$\{onlyTalkMode \? ' active' : ''\}`\}/);
assert.match(sidebarSource, /aria-pressed=\{onlyTalkMode\}/);
assert.match(
  sidebarSource,
  /onlyTalkMode \? <Cloud size=\{12\} \/> : <Folder size=\{12\} \/>/,
  'The only-talk toggle must show the current mode with project and cloud icons',
);
assert.match(
  sidebarSource,
  /onlyTalkMode[\s\S]*?language === 'zh' \? '仅会话' : 'Only talk'[\s\S]*?language === 'zh' \? '项目' : 'Projects'/,
  'The only-talk toggle label must describe the current mode',
);
assert.match(sidebarSource, /onlyTalkConversations\.map\(renderStandaloneConversation\)/);
assert.match(sidebarSource, /cardbush_conversation_read_state_v1/);
assert.match(sidebarSource, /conversationReadReceipt\(/);
assert.match(sidebarSource, /document\.visibilityState !== 'visible' \|\| !document\.hasFocus\(\)/);
assert.match(sidebarSource, /key: options\.unread \? 'mark-read' : 'mark-unread'/);
assert.match(sidebarSource, /标记为已读/);
assert.match(sidebarSource, /标记为未读/);
assert.match(sidebarSource, /className="conversation-unread-indicator"/);
assert.match(stylesSource, /\.conversation-unread-indicator\s*\{[\s\S]*?background:\s*var\(--accent\)/);
assert.match(stylesSource, /\.conversation-row\.unread \.conversation-title\s*\{/);
assert.doesNotMatch(sidebarSource, /window\.prompt\([\s\S]{0,120}重命名对话/);
assert.doesNotMatch(appSource, /window\.prompt\([\s\S]{0,120}重命名项目/);
assert.match(appSource, /const \[projectRenameTarget, setProjectRenameTarget\]/);
assert.match(appSource, /if \(action === 'rename'\) \{[\s\S]*?setProjectRenameTarget\(project\)/);
assert.match(appSource, /function ProjectRenameDialog\(/);
assert.match(appSource, /可同时重命名真实项目文件夹/);
assert.match(appSource, /同时重命名项目文件夹（同一父目录）/);
assert.match(appSource, /const renameProject = useCallback/);
assert.match(appSource, /chat\.relocateProjectConversations/);
assert.match(appSource, /renameProject\(projectRenameTarget, title, renameFolder\)/);
assert.match(stylesSource, /\.project-rename-dialog\s*\{/);
assert.match(stylesSource, /\.project-rename-folder-option\s*\{/);
assert.match(sidebarSource, /className=\{`conversation-rename-form\$\{renameFailed \? ' invalid' : ''\}`\}/);
assert.match(sidebarSource, /maxLength=\{160\}/);
assert.match(sidebarSource, /if \(event\.key === 'Escape'\)/);
assert.match(sidebarSource, /onDoubleClick=\{\(event\) => \{[\s\S]*?beginRename\(\)/);
assert.match(sidebarSource, /if \(event\.key === 'F2'\)/);
assert.match(sidebarSource, /const saved = await onRename\(nextTitle\)/);
assert.match(stylesSource, /\.conversation-rename-form input\s*\{/);
assert.match(chatHookSource, /const renameConversation = useCallback\(async \(conversationId: string, title: string\)/);
assert.match(chatHookSource, /const synced = await updateConversation\(\{ sessionId: normalizedId, title: nextTitle \}\)/);
assert.match(
  chatHookSource,
  /item\.id === normalizedId && item\.title === nextTitle[\s\S]*?title: previous\.title/,
  'A failed rename must roll back only the optimistic title written by that request',
);
assert.match(sidebarSource, /key=\{onlyTalkMode \? 'only-talk' : 'projects'\}/);
assert.match(
  appSource,
  /createConversation\(onlyTalkMode \? null : activeConversationProjectDir \|\| undefined\)/,
  'Only-talk new chats must explicitly bypass the recent-project fallback',
);
assert.match(appSource, /cardbush_only_talk_mode/);
assert.match(
  appSource,
  /const changeOnlyTalkMode[\s\S]*?chat\.clearConversationSelection\(\)/,
  'Switching chat modes without a matching conversation must show an empty draft instead of creating a session.',
);
const onlyTalkModeBlock = appSource.match(
  /const changeOnlyTalkMode[\s\S]*?\}, \[chat\]\);/,
)?.[0] ?? '';
assert.doesNotMatch(
  onlyTalkModeBlock,
  /chat\.startConversation/,
  'The only-talk/project toggle must never create a conversation implicitly.',
);
assert.match(conversationWorkspaceSource, /export function isOnlyTalkConversation/);
assert.match(
  conversationWorkspaceSource,
  /metadataMode === 'task'/,
  'Task metadata must override a stale project-dir index when grouping conversations',
);
assert.match(stylesSource, /@keyframes sidebar-mode-enter/);
assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sidebar-mode-content/);
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
assert.match(sidebarSource, /function ScrollingConversationTitle\(/);
assert.match(sidebarSource, /content\.scrollWidth - viewport\.clientWidth/);
assert.match(sidebarSource, /\[cardbush:sidebar-title-layout\]/);
assert.doesNotMatch(sidebarSource, /conversation-change-badge/);
assert.doesNotMatch(sidebarSource, /overlapsDiff/);
assert.doesNotMatch(sidebarSource, /className=\{`conversation-title[^\n]*[\s\S]{0,160}title=\{title\}/);
assert.match(sidebarSource, /<ScrollingConversationTitle title=\{conversation\.title\}/);
assert.match(stylesSource, /@keyframes conversation-title-marquee/);
assert.match(
  stylesSource,
  /\.conversation-row > \.conversation-title\s*\{[\s\S]*?width:\s*0[\s\S]*?flex:\s*1 1 0/,
  'Long titles must shrink inside the title lane instead of pushing action controls',
);
assert.doesNotMatch(stylesSource, /\.conversation-change-badge\s*\{/);
assert.match(sidebarSource, /key:\s*'diff'[\s\S]*?查看 Diff/);
assert.match(
  stylesSource,
  /\.conversation-row\s*\{[\s\S]*?box-sizing:\s*border-box[\s\S]*?width:\s*100%/,
  'Conversation padding must be included in the row width so the menu stays inside the sidebar',
);
assert.match(
  stylesSource,
  /\.conversation-row\.nested\s*\{[\s\S]*?padding-right:\s*36px/,
  'Nested titles must reserve a fixed action column for the conversation menu',
);
assert.match(appSource, /cardbush_recent_project_dir/);
assert.match(
  appSource,
  /const activeProject = activeConversationProjectDir[\s\S]*?projectDir === undefined[\s\S]*?activeProject\?\.rootPath\.trim\(\) \|\| fallbackProjectDir \|\| undefined[\s\S]*?chat\.prepareConversation\(resolvedProjectDir, undefined, resolvedProjectId\)/,
  'New chat must prefer the active available project, then reserve a draft without persisting it',
);
assert.match(appSource, /function WelcomeProjectSwitcher\(/);
assert.match(appSource, /placeholder=\{language === 'zh' \? '搜索项目' : 'Search projects'\}/);
assert.match(appSource, /不在项目中工作/);
assert.match(
  appSource,
  /className=\{`welcome-input-stack\$\{onlyTalkMode \? ' only-talk' : ''\}`\}[\s\S]*?!onlyTalkMode && \([\s\S]*?<WelcomeProjectSwitcher[\s\S]*?\{welcomeComposer\}/,
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

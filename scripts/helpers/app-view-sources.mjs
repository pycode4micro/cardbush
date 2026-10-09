import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const appViewFiles = [
  'src/App.tsx',
  'src/components/AppErrorBoundary.tsx',
  'src/components/CopyToastHost.tsx',
  'src/features/appearance/themePreferences.ts',
  'src/features/settings/appSettingsStore.ts',
  'src/features/settings/localPreferences.ts',
  'src/features/settings/modelPreferences.ts',
  'src/features/sidebar/projectStore.ts',
  'src/features/sidebar/ProjectRenameDialog.tsx',
  'src/features/panels/FeaturePanel.tsx',
  'src/features/inspector/useInspectorWorkspace.ts',
  'src/features/inspector/useInspectorRecovery.ts',
  'src/features/inspector/useInspectorTileDrag.ts',
  'src/features/chat/ChatPanel.tsx',
  'src/features/chat/scrollDebug.ts',
  'src/features/chat/useConversationWorkSummary.ts',
  'src/features/chat/ScrollBottomButton.tsx',
  'src/features/chat/TaskWorkspaceBar.tsx',
  'src/features/chat/ChatStatusViews.tsx',
  'src/features/chat/WelcomeComposer.tsx',
  'src/components/TopBar.tsx',
  'src/components/WindowSidebarToggle.tsx',
  'src/components/WindowFrame.tsx',
  'src/features/windowMenu/applicationMenus.ts',
  'src/features/interactions/InteractionCard.tsx',
  'src/features/inspector/inspectorTargets.ts',
  'src/features/inspector/InspectorWebview.tsx',
  'src/features/inspector/InspectorActions.tsx',
  'src/features/inspector/InspectorTabStrip.tsx',
  'src/features/inspector/InspectorTabPages.tsx',
  'src/features/inspector/TextInspectorPreview.tsx',
  'src/features/inspector/FilePreviewFallback.tsx',
  'src/features/inspector/filePreviewRegistry.ts',
  'src/features/inspector/inspectorFilePreviewRenderers.tsx',
  'src/shared/cssEscape.ts',
];

// Legacy UI contracts span composition and leaf views. Read their real owners
// after extraction, without weakening assertions or requiring one giant App.
// Module direction and mounted behavior are covered by test:app-views.
export function readAppViewSources() {
  return appViewFiles.map(file => readFileSync(resolve(file), 'utf8')).join('\n');
}

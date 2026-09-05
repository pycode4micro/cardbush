import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const appViewFiles = [
  'src/App.tsx',
  'src/features/chat/ChatPanel.tsx',
  'src/features/chat/ChatStatusViews.tsx',
  'src/features/chat/WelcomeComposer.tsx',
  'src/components/TopBar.tsx',
  'src/features/interactions/InteractionCard.tsx',
  'src/features/inspector/inspectorTargets.ts',
  'src/features/inspector/InspectorWebview.tsx',
  'src/shared/cssEscape.ts',
];

// Legacy UI contracts span composition and leaf views. Read their real owners
// after extraction, without weakening assertions or requiring one giant App.
// Module direction and mounted behavior are covered by test:app-views.
export function readAppViewSources() {
  return appViewFiles.map(file => readFileSync(resolve(file), 'utf8')).join('\n');
}

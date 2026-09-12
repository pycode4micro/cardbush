import type { AppLanguage } from './types';
import { TeamSidebar } from './TeamSidebar';
import { TeamWorkflowPanel } from './TeamWorkflowPanel';

export function TeamPluginWorkspace({ language }: { language: AppLanguage }) {
  return <div className="team-plugin-workspace">
    <TeamSidebar language={language} embedded />
    <TeamWorkflowPanel language={language} workflowValidationAvailable={false} />
  </div>;
}

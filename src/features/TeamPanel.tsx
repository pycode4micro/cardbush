import type { AppLanguage } from '../types';
import { TeamWorkflowPanel } from './team/TeamWorkflowPanel';

export function TeamPanel({
  language,
  activeProjectDir,
  workflowValidationAvailable,
}: {
  language: AppLanguage;
  activeProjectDir?: string;
  workflowValidationAvailable: boolean;
}) {
  return (
    <TeamWorkflowPanel
      language={language}
      activeProjectDir={activeProjectDir}
      workflowValidationAvailable={workflowValidationAvailable}
    />
  );
}

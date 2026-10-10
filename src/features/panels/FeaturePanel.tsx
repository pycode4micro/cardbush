import { LoaderCircle } from 'lucide-react';
import { Suspense } from 'react';
import { TopBar } from '../../components/TopBar';
import { useTeamWorkspace } from '../team/teamWorkspaceStore';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import { type AppLanguage, type AppSection, type BackendCapabilities, type SkillDetail, type SkillSummary } from '../../types';
import { sectionLabels } from '../appSections';

const LazyFeatureContentPanel = recoverableLazy('feature-panel', async () => {
  const module = await import('./index');
  return { default: module.FeatureContentPanel };
}, (props, retry) => <DeferredModuleNotice language={props.language} retry={retry} />);

export function FeaturePanelLoading({ language }: { language: AppLanguage }) {
  return (
    <div className="feature-content feature-loading">
      <LoaderCircle size={18} />
      <span>{language === 'zh' ? '正在加载...' : 'Loading...'}</span>
    </div>
  );
}

export function FeaturePanel({
  language,
  backendCapabilities,
  onOpenPluginPrompt,
  section,
  activeProjectDir,
  workflowValidationAvailable,
  inspectorOpen,
  onToggleInspector,
  skills,
  disabledSkillNames,
  onToggleSkill,
  onReloadSkills,
  onLoadSkillDetail,
  onCreateAutomation,
  onOpenConversation,
}: {
  language: AppLanguage;
  backendCapabilities: BackendCapabilities;
  onOpenPluginPrompt: (prompt: string) => void;
  section: AppSection;
  activeProjectDir?: string;
  workflowValidationAvailable: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReloadSkills: () => Promise<SkillSummary[]>;
  onLoadSkillDetail: (skillName: string) => Promise<SkillDetail>;
  onCreateAutomation: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const teamWorkspace = useTeamWorkspace(section === 'team');
  const label = section === 'team' ? teamWorkspace.title || sectionLabels[section][language] : sectionLabels[section][language];
  return (
    <div className="feature-panel">
      {section !== 'md-presentation' && <TopBar
        title={label}
        language={language}
        inspectorOpen={inspectorOpen}
        onToggleInspector={onToggleInspector}
      />}
      <Suspense fallback={<FeaturePanelLoading language={language} />}>
        <LazyFeatureContentPanel
          language={language}
          backendCapabilities={backendCapabilities}
          onOpenPluginPrompt={onOpenPluginPrompt}
          section={section}
          inspectorOpen={inspectorOpen}
          onToggleInspector={onToggleInspector}
          activeProjectDir={activeProjectDir}
          workflowValidationAvailable={workflowValidationAvailable}
          skills={skills}
          disabledSkillNames={disabledSkillNames}
          onToggleSkill={onToggleSkill}
          onReloadSkills={onReloadSkills}
          onLoadSkillDetail={onLoadSkillDetail}
          onCreateAutomation={onCreateAutomation}
          onOpenConversation={onOpenConversation}
        />
      </Suspense>
    </div>
  );
}

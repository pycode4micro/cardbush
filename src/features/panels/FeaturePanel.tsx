import { uiText } from '../../i18n';
import { LoaderCircle } from 'lucide-react';
import { Suspense } from 'react';
import { TopBar } from '../../components/TopBar';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import { type AppLanguage, type AppSection, type BackendCapabilities, type SkillDetail, type SkillSummary } from '../../types';
import { sectionLabels } from '../appSections';
import type { CreationChatOptions } from '../mdPresentation/CreationConversation';

const LazyFeatureContentPanel = recoverableLazy('feature-panel', async () => {
  const module = await import('./index');
  return { default: module.FeatureContentPanel };
}, (props, retry) => <DeferredModuleNotice language={props.language} retry={retry} />);

export function FeaturePanelLoading({ language }: { language: AppLanguage }) {
  return (
    <div className="feature-content feature-loading">
      <LoaderCircle size={18} />
      <span>{uiText(language)('featureContentPanel.loading')}</span>
    </div>
  );
}

export function FeaturePanel({
  language,
  backendCapabilities,
  onOpenPluginPrompt,
  onEditHomeLayout,
  section,
  activeProjectDir,
  workflowValidationAvailable,
  inspectorOpen,
  onToggleInspector,
  headerActionsTarget,
  skills,
  disabledSkillNames,
  onToggleSkill,
  onReloadSkills,
  onLoadSkillDetail,
  onOpenConversation,
  creationChatOptions,
}: {
  language: AppLanguage;
  backendCapabilities: BackendCapabilities;
  onOpenPluginPrompt: (prompt: string) => void;
  onEditHomeLayout: () => void;
  section: AppSection;
  activeProjectDir?: string;
  workflowValidationAvailable: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  headerActionsTarget: HTMLElement | null;
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReloadSkills: () => Promise<SkillSummary[]>;
  onLoadSkillDetail: (skillName: string) => Promise<SkillDetail>;
  onOpenConversation: (conversationId: string) => void;
  creationChatOptions?: CreationChatOptions;
}) {
  const label = uiText(language)(sectionLabels[section]);
  return (
    <section className="feature-panel" aria-label={label}>
      <TopBar
        title={label}
        actionsTarget={headerActionsTarget}
        language={language}
        inspectorOpen={inspectorOpen}
        onToggleInspector={onToggleInspector}
      />
      <Suspense fallback={<FeaturePanelLoading language={language} />}>
        <LazyFeatureContentPanel
          creationChatOptions={creationChatOptions}
          language={language}
          backendCapabilities={backendCapabilities}
          onOpenPluginPrompt={onOpenPluginPrompt}
          onEditHomeLayout={onEditHomeLayout}
          section={section}
          activeProjectDir={activeProjectDir}
          workflowValidationAvailable={workflowValidationAvailable}
          skills={skills}
          disabledSkillNames={disabledSkillNames}
          onToggleSkill={onToggleSkill}
          onReloadSkills={onReloadSkills}
          onLoadSkillDetail={onLoadSkillDetail}
          onOpenConversation={onOpenConversation}
        />
      </Suspense>
    </section>
  );
}

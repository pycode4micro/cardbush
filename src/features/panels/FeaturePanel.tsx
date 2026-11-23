import { uiText } from '../../i18n';
import { LoaderCircle } from 'lucide-react';
import { Suspense, type ComponentProps, type ReactNode } from 'react';
import { TopBar } from '../../components/TopBar';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import type { AppLanguage, BackendCapabilities, SkillDetail, SkillSummary } from '../../types';
import { sectionLabels } from '../appSections';
import type { CreationChatOptions } from '../mdPresentation/CreationConversation';
import type { FeatureSection } from '../navigation/appPage';

const retryFeature = ({ language }: { language: AppLanguage }, retry: () => void) =>
  <DeferredModuleNotice language={language} retry={retry} />;
const Components = recoverableLazy<ComponentProps<typeof import('../components/ComponentsApp').ComponentsApp>>('components', () =>
  import('../components/ComponentsApp').then(({ ComponentsApp }) => ({ default: ComponentsApp })), retryFeature);
const Creation = recoverableLazy<ComponentProps<typeof import('../creationCanvas/CreationCanvasApp').CreationCanvasApp>>('creation-canvas', () =>
  import('../creationCanvas/CreationCanvasApp').then(({ CreationCanvasApp }) => ({ default: CreationCanvasApp })), retryFeature);
const Plugins = recoverableLazy<ComponentProps<typeof import('../plugins/PluginWorkspace').PluginWorkspace>>('plugin-workspace', () =>
  import('../plugins/PluginWorkspace').then(({ PluginWorkspace }) => ({ default: PluginWorkspace })), retryFeature);
const Team = recoverableLazy<ComponentProps<typeof import('../team/TeamWorkspace').TeamWorkspace>>('team-workspace', () =>
  import('../team/TeamWorkspace').then(({ TeamWorkspace }) => ({ default: TeamWorkspace })), retryFeature);

function FeaturePanelLoading({ language }: { language: AppLanguage }) {
  return (
    <div className="feature-content feature-loading">
      <LoaderCircle size={18} />
      <span>{uiText(language)('common.loading')}</span>
    </div>
  );
}

type FeaturePanelProps = {
  language: AppLanguage;
  backendCapabilities: BackendCapabilities;
  onOpenPluginPrompt: (prompt: string) => void;
  onEditHomeLayout: () => void;
  section: FeatureSection;
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
};

const content: Record<FeatureSection, (props: FeaturePanelProps) => ReactNode> = {
  components: ({ language, onOpenPluginPrompt, onEditHomeLayout }) =>
    <Components language={language} onCreate={onOpenPluginPrompt} onEditHomeLayout={onEditHomeLayout} />,
  'md-presentation': ({ language, creationChatOptions }) => <Creation {...creationChatOptions} language={language} />,
  team: ({ language, creationChatOptions, onOpenConversation }) =>
    <Team language={language} chatOptions={creationChatOptions} onOpenConversation={onOpenConversation} />,
  plugins: ({ language, backendCapabilities, skills, disabledSkillNames, onToggleSkill, onReloadSkills, onLoadSkillDetail, onOpenPluginPrompt }) =>
    <Plugins language={language} capabilities={backendCapabilities}
      skills={skills} disabledSkillNames={disabledSkillNames} onToggleSkill={onToggleSkill}
      onReloadSkills={onReloadSkills} onLoadSkillDetail={onLoadSkillDetail} onOpenPrompt={onOpenPluginPrompt} />,
};

export function FeaturePanel(props: FeaturePanelProps) {
  const { language, section, headerActionsTarget, inspectorOpen, onToggleInspector } = props;
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
        {content[section](props)}
      </Suspense>
    </section>
  );
}

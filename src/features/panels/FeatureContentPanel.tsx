import { uiText, localizedContent } from '../../i18n';
import {
  CheckCircle2,
  Circle,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import type {
  AppLanguage,
  AppSection,
  BackendCapabilities,
  SkillDetail,
  SkillSummary,
} from '../../types';
import { SkillIcon } from '../skills/SkillIcon';
import { AutomationPanel } from '../automations/AutomationPanel';
import { PluginWorkspace } from '../plugins/PluginWorkspace';
import { ComponentsApp } from '../components/ComponentsApp';

import { TeamWorkspace } from '../team/TeamWorkspace';
import type { CreationChatOptions } from '../mdPresentation/CreationConversation';
const CreationCanvasApp = lazy(() => import('../creationCanvas/CreationCanvasApp').then(module => ({ default: module.CreationCanvasApp })));

export function FeatureContentPanel({
  language,
  backendCapabilities,
  onOpenPluginPrompt,
  section,
  inspectorOpen,
  onToggleInspector,
  skills,
  disabledSkillNames,
  onToggleSkill,
  onReloadSkills,
  onLoadSkillDetail,
  onCreateAutomation,
  onOpenConversation,
  creationChatOptions,
}: {
  language: AppLanguage;
  backendCapabilities: BackendCapabilities;
  onOpenPluginPrompt: (prompt: string) => void;
  section: AppSection;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  activeProjectDir?: string;
  workflowValidationAvailable: boolean;
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReloadSkills: () => Promise<SkillSummary[]>;
  onLoadSkillDetail: (skillName: string) => Promise<SkillDetail>;
  onCreateAutomation: () => void;
  onOpenConversation: (conversationId: string) => void;
  creationChatOptions?: CreationChatOptions;
}) {
  if (section === 'components') return <ComponentsApp language={language}/>;
  if (section === 'md-presentation') return <Suspense fallback={<FeaturePanelLoading language={language}/>}><CreationCanvasApp {...creationChatOptions} language={language} inspectorOpen={inspectorOpen} onToggleInspector={onToggleInspector}/></Suspense>;
  if (section === 'plugins') return <PluginWorkspace language={language} capabilities={backendCapabilities}
    skills={skills} disabledSkillNames={disabledSkillNames} onToggleSkill={onToggleSkill}
    onReloadSkills={onReloadSkills} onLoadSkillDetail={onLoadSkillDetail} onOpenPrompt={onOpenPluginPrompt} />;
  if (section === 'automations') return <AutomationPanel language={language} onOpenConversation={onOpenConversation} onCreateAutomation={onCreateAutomation} />;
  if (section === 'skills') {
    return (
      <SkillsPanel
        language={language}
        items={skills}
        disabledSkillNames={disabledSkillNames}
        onToggleSkill={onToggleSkill}
        onReload={onReloadSkills}
        onLoadDetail={onLoadSkillDetail}
      />
    );
  }
  if (section === 'subagents') {
    return null;
  }
  if (section === 'team') {
    return (
      <Suspense fallback={<FeaturePanelLoading language={language} />}>
        <TeamWorkspace language={language} chatOptions={creationChatOptions} onOpenConversation={onOpenConversation}/>
      </Suspense>
    );
  }
  return null;
}

function FeaturePanelLoading({ language }: { language: AppLanguage }) {
  return (
    <div className="feature-content feature-loading">
      <LoaderCircle size={18} />
      <span>{uiText(language)('featureContentPanel.loading')}</span>
    </div>
  );
}

function SkillsPanel({
  language,
  items,
  disabledSkillNames,
  onToggleSkill,
  onReload,
  onLoadDetail,
}: {
  language: AppLanguage;
  items: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReload: () => Promise<SkillSummary[]>;
  onLoadDetail: (skillName: string) => Promise<SkillDetail>;
}) {
  const [query, setQuery] = useState('');
  const [localItems, setLocalItems] = useState(items);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    setLocalItems(items);
  }, [items]);

  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo(
    () =>
      localItems
        .filter((skill) => {
          if (!normalizedQuery) {
            return true;
          }
          return `${skill.name} ${skill.description} ${skill.descriptionZh ?? ''} ${skill.path}`
            .toLowerCase()
            .includes(normalizedQuery);
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
    [localItems, normalizedQuery],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const loaded = await onReload();
      setLocalItems(loaded);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [onReload]);

  const openDetail = useCallback(
    async (skill: SkillSummary) => {
      setDetail(null);
      setDetailError('');
      setDetailLoading(true);
      try {
        const loaded = await onLoadDetail(skill.name);
        setDetail(loaded);
      } catch (caught) {
        setDetailError(caught instanceof Error ? caught.message : String(caught));
        setDetail({
          ...skill,
          packageDir: '',
          content: '',
          routingHidden: false,
          requires: [],
          conflictsWith: [],
          companionTools: [],
          blockedTools: [],
          requiredReads: [],
          conditionalReads: [],
          resourceQuickRefs: [],
        });
      } finally {
        setDetailLoading(false);
      }
    },
    [onLoadDetail],
  );

  return (
    <div className="feature-content">
      <div className="feature-toolbar">
        <div className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={uiText(language)('featureContentPanel.searchSkills')}
          />
        </div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void reload()}>
          {loading ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
          {uiText(language)('automationPanel.refresh')}
        </button>
      </div>
      <p className="feature-hint">
        {loading
          ? uiText(language)('featureContentPanel.loadingTheCardbushSkillCatalog')
          : uiText(language)('featureContentPanel.skillsOpenDetailsToViewSkillMd', { value1: localItems.length })}
      </p>
      {error && <p className="feature-error">{error}</p>}
      <div className="result-stack">
        {results.map((skill) => {
          const enabled = !disabledSkillNames.has(skill.name);
          return (
            <article
              className={`result-card skill skill-tile ${enabled ? '' : 'disabled'}`}
              key={skill.name}
            >
              <button
                className="skill-tile-main"
                type="button"
                onClick={() => void openDetail(skill)}
              >
                <SkillIcon skill={skill} />
                <div>
                  <h3>{skill.name}</h3>
                  <p>{localizedContent({ zh: skill.descriptionZh, en: skill.description }, language)}</p>
                  <small>{skill.path}</small>
                </div>
                <span className="skill-detail-label">
                  {uiText(language)('featureContentPanel.details')}
                </span>
              </button>
              <button
                className={`skill-toggle ${enabled ? 'on' : ''}`}
                type="button"
                onClick={() => onToggleSkill(skill.name, !enabled)}
              >
                {enabled ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                {enabled
                  ? uiText(language)('featureContentPanel.enabled')
                  : uiText(language)('featureContentPanel.disabled')}
              </button>
            </article>
          );
        })}
      </div>
      {detail && (
        <SkillDetailDialog
          language={language}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onClose={() => {
            setDetail(null);
            setDetailError('');
          }}
        />
      )}
    </div>
  );
}

function SkillDetailDialog({
  language,
  detail,
  loading,
  error,
  onClose,
}: {
  language: AppLanguage;
  detail: SkillDetail;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="skill-detail-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <SkillIcon skill={detail} compact />
          <strong>{detail.name}</strong>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {loading ? (
          <div className="skill-detail-loading">
            <LoaderCircle size={22} />
            {uiText(language)('featureContentPanel.loadingSkillDetail')}
          </div>
        ) : (
          <>
            <p>{(localizedContent({ zh: detail.descriptionZh, en: detail.description }, language)) || detail.description || (uiText(language)('featureContentPanel.noDescription'))}</p>
            <div className="skill-meta">
              {detail.version && <span>{uiText(language)('featureContentPanel.v')}{detail.version}</span>}
              {detail.routingHidden && <span>{uiText(language)('featureContentPanel.hiddenRouting')}</span>}
              {detail.minServerVersion && <span>{uiText(language)('featureContentPanel.server_gt')}{detail.minServerVersion}</span>}
              {detail.requires.map((item) => (
                <span key={`requires-${item}`}>{uiText(language)('featureContentPanel.requires')}{item}</span>
              ))}
            </div>
            {detail.packageDir && <InfoRow label={uiText(language)('featureContentPanel.package_dir')} value={detail.packageDir} />}
            {detail.path && <InfoRow label={uiText(language)('featureContentPanel.skill_md')} value={detail.path} />}
            {error ? (
              <p className="feature-error">{error}</p>
            ) : (
              <pre className="skill-content">{detail.content || (uiText(language)('featureContentPanel.skillDetailIsEmpty'))}</pre>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}






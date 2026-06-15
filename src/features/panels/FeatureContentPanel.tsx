import {
  CheckCircle2,
  Circle,
  Code2,
  Edit3,
  LoaderCircle,
  Puzzle,
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
  ConversationSummary,
  SkillDetail,
  SkillSummary,
} from '../../types';

const LazySubagentsPanel = lazy(async () => {
  const module = await import('../SubagentsPanel');
  return { default: module.SubagentsPanel };
});

const LazyTeamPanel = lazy(async () => {
  const module = await import('../TeamPanel');
  return { default: module.TeamPanel };
});

export function FeatureContentPanel({
  language,
  section,
  conversations,
  skills,
  disabledSkillNames,
  onToggleSkill,
  onReloadSkills,
  onLoadSkillDetail,
  onCreateConversation,
  onOpenConversation,
}: {
  language: AppLanguage;
  section: AppSection;
  conversations: ConversationSummary[];
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReloadSkills: () => Promise<SkillSummary[]>;
  onLoadSkillDetail: (skillName: string) => Promise<SkillDetail>;
  onCreateConversation: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  if (section === 'search') {
    return (
      <SearchPanel
        language={language}
        conversations={conversations}
        onCreateConversation={onCreateConversation}
        onOpenConversation={onOpenConversation}
      />
    );
  }
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
    return (
      <Suspense fallback={<FeaturePanelLoading language={language} />}>
        <LazySubagentsPanel language={language} />
      </Suspense>
    );
  }
  if (section === 'team') {
    return (
      <Suspense fallback={<FeaturePanelLoading language={language} />}>
        <LazyTeamPanel language={language} />
      </Suspense>
    );
  }
  return null;
}

function FeaturePanelLoading({ language }: { language: AppLanguage }) {
  return (
    <div className="feature-content feature-loading">
      <LoaderCircle size={18} />
      <span>{language === 'zh' ? '正在加载...' : 'Loading...'}</span>
    </div>
  );
}

function SearchPanel({
  language,
  conversations,
  onCreateConversation,
  onOpenConversation,
}: {
  language: AppLanguage;
  conversations: ConversationSummary[];
  onCreateConversation: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo(
    () =>
      conversations.filter((conversation) => {
        if (!normalizedQuery) {
          return true;
        }
        return `${conversation.title} ${conversation.preview}`
          .toLowerCase()
          .includes(normalizedQuery);
      }),
    [conversations, normalizedQuery],
  );

  return (
    <div className="feature-content">
      <div className="feature-toolbar">
        <div className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={language === 'zh' ? '搜索标题或摘要' : 'Search titles or summaries'}
          />
        </div>
        <button className="primary-button" type="button" onClick={onCreateConversation}>
          <Edit3 size={16} />
          {language === 'zh' ? '新会话' : 'New chat'}
        </button>
      </div>
      <div className="result-stack">
        {results.map((conversation) => (
          <button
            className="result-card result-card-button"
            key={conversation.id}
            type="button"
            onClick={() => onOpenConversation(conversation.id)}
          >
            <h3>{conversation.title}</h3>
            <p>{conversation.preview}</p>
          </button>
        ))}
      </div>
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
            placeholder={language === 'zh' ? '搜索技能' : 'Search skills'}
          />
        </div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void reload()}>
          {loading ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
          {language === 'zh' ? '刷新' : 'Refresh'}
        </button>
      </div>
      <p className="feature-hint">
        {loading
          ? language === 'zh'
            ? '正在从 BushServer 加载 skills...'
            : 'Loading skills from BushServer...'
          : language === 'zh'
            ? `共 ${localItems.length} 个 skills，点击详情查看 SKILL.md。`
            : `${localItems.length} skills. Open details to view SKILL.md.`}
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
                <Code2 size={18} />
                <div>
                  <h3>{skill.name}</h3>
                  <p>{language === 'zh' ? skill.descriptionZh : skill.description}</p>
                  <small>{skill.path}</small>
                </div>
                <span className="skill-detail-label">
                  {language === 'zh' ? '详情' : 'Details'}
                </span>
              </button>
              <button
                className={`skill-toggle ${enabled ? 'on' : ''}`}
                type="button"
                onClick={() => onToggleSkill(skill.name, !enabled)}
              >
                {enabled ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                {enabled
                  ? language === 'zh'
                    ? '已启用'
                    : 'Enabled'
                  : language === 'zh'
                    ? '已关闭'
                    : 'Disabled'}
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
          <Puzzle size={18} />
          <strong>{detail.name}</strong>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {loading ? (
          <div className="skill-detail-loading">
            <LoaderCircle size={22} />
            {language === 'zh' ? '正在加载 Skill 详情...' : 'Loading skill detail...'}
          </div>
        ) : (
          <>
            <p>{(language === 'zh' ? detail.descriptionZh : detail.description) || detail.description || (language === 'zh' ? '暂无描述' : 'No description')}</p>
            <div className="skill-meta">
              {detail.version && <span>v{detail.version}</span>}
              {detail.routingHidden && <span>{language === 'zh' ? '隐藏路由' : 'hidden routing'}</span>}
              {detail.minServerVersion && <span>server &gt;= {detail.minServerVersion}</span>}
              {detail.requires.map((item) => (
                <span key={`requires-${item}`}>requires {item}</span>
              ))}
            </div>
            {detail.packageDir && <InfoRow label="package_dir" value={detail.packageDir} />}
            {detail.path && <InfoRow label="SKILL.md" value={detail.path} />}
            {error ? (
              <p className="feature-error">{error}</p>
            ) : (
              <pre className="skill-content">{detail.content || (language === 'zh' ? 'Skill 详情为空' : 'Skill detail is empty')}</pre>
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







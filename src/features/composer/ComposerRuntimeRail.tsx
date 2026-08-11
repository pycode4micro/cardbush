import { Brain, Code2, LoaderCircle, PanelRightOpen, Puzzle, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { AppLanguage, CapabilityCandidatesUpdate } from '../../types';
import type {
  ConversationChangeReport,
  ConversationChangeSummary,
  ToolFileChange,
} from '../tools';

export type ThinkingNotice = {
  id: string;
  turnId: string;
  preview: string;
  content: string;
  createdAt: string;
};

export function ComposerRuntimeRail({
  language,
  running,
  thinkingNotice,
  thinkingOpen,
  changeReports,
  changeSummary,
  capabilityCandidates,
  onToggleThinking,
  onCloseThinking,
  onOpenChangeReview,
}: {
  language: AppLanguage;
  running: boolean;
  thinkingNotice: ThinkingNotice | null;
  thinkingOpen: boolean;
  changeReports: ConversationChangeReport[];
  changeSummary: ConversationChangeSummary | null;
  capabilityCandidates?: CapabilityCandidatesUpdate;
  onToggleThinking: () => void;
  onCloseThinking: () => void;
  onOpenChangeReview: () => void;
}) {
  const [changesOpen, setChangesOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const changedFiles = useMemo(
    () => mergeChangedFiles(changeReports),
    [changeReports],
  );
  const expanded = thinkingOpen || changesOpen || capabilitiesOpen;
  const changedLineCount = changeSummary
    ? changeSummary.additions + changeSummary.deletions
    : 0;

  useEffect(() => {
    if (!changeSummary) {
      setChangesOpen(false);
    }
  }, [changeSummary]);

  useEffect(() => {
    if (!capabilityCandidates) {
      setCapabilitiesOpen(false);
    }
  }, [capabilityCandidates]);

  return (
    <div className={`composer-runtime-rail ${expanded ? 'expanded' : ''}`}>
      {thinkingOpen && thinkingNotice && (
        <section className="runtime-context-panel thinking-context-panel" aria-label="Thinking">
          <header>
            <span><Brain size={14} /><strong>{language === 'zh' ? '思考中' : 'Thinking'}</strong></span>
            <button type="button" title={language === 'zh' ? '收起' : 'Collapse'} onClick={onCloseThinking}>
              <X size={14} />
            </button>
          </header>
          <div className="thinking-context-content">{thinkingNotice.content}</div>
        </section>
      )}
      {changesOpen && changeSummary && (
        <section
          className="runtime-context-panel change-context-panel"
          aria-label={language === 'zh' ? '文件更改' : 'File changes'}
        >
          <header>
            <span>
              <Code2 size={14} />
              <strong>
                {language === 'zh'
                  ? `${changeSummary.fileCount} 个文件 · ${changedLineCount} 行`
                  : `${changeSummary.fileCount} files · ${changedLineCount} lines`}
              </strong>
            </span>
            <div className="runtime-context-actions">
              <button
                type="button"
                title={language === 'zh' ? '完整审阅' : 'Open full review'}
                onClick={onOpenChangeReview}
              >
                <PanelRightOpen size={14} />
              </button>
              <button
                type="button"
                title={language === 'zh' ? '收起' : 'Collapse'}
                onClick={() => setChangesOpen(false)}
              >
                <X size={14} />
              </button>
            </div>
          </header>
          <div className="change-context-files">
            {changedFiles.length > 0 ? changedFiles.map((file) => (
              <div className="change-context-file" key={file.path}>
                <strong title={file.path}>{file.path}</strong>
                <span>
                  {file.additions > 0 && <b className="diff-count add">+{file.additions}</b>}
                  {file.deletions > 0 && <b className="diff-count del">-{file.deletions}</b>}
                </span>
              </div>
            )) : (
              <p>
                {language === 'zh'
                  ? '已收到变更统计，文件明细将在工具返回 diff 后显示。'
                  : 'Change totals are available; file details appear when the tool returns a diff.'}
              </p>
            )}
          </div>
        </section>
      )}
      {capabilitiesOpen && capabilityCandidates && (
        <section
          className="runtime-context-panel capability-context-panel"
          aria-label={language === 'zh' ? '候选能力' : 'Capability candidates'}
        >
          <header>
            <span>
              <Puzzle size={14} />
              <strong>{language === 'zh' ? '候选能力' : 'Capability candidates'}</strong>
            </span>
            <button
              type="button"
              title={language === 'zh' ? '收起' : 'Collapse'}
              onClick={() => setCapabilitiesOpen(false)}
            >
              <X size={14} />
            </button>
          </header>
          <div className="capability-context-content">
            <p>
              {language === 'zh'
                ? '本地检索建议，仅供 Agent 自主选择，不代表已装载或必须使用。'
                : 'Local retrieval hints only. The agent decides whether to load or use them.'}
            </p>
            {capabilityCandidates.skills.length > 0 && (
              <div className="capability-candidate-group">
                <strong>Skills</strong>
                {capabilityCandidates.skills.map((candidate) => (
                  <span key={`skill:${candidate.name}`} title={candidate.description}>
                    {candidate.name}
                  </span>
                ))}
              </div>
            )}
            {capabilityCandidates.tools.length > 0 && (
              <div className="capability-candidate-group">
                <strong>Tools</strong>
                {capabilityCandidates.tools.map((candidate) => (
                  <span key={`tool:${candidate.name}`} title={candidate.description}>
                    {candidate.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
      <div className="composer-runtime-tabs">
        {running && !thinkingNotice && (
          <div className="runtime-context-tab processing-context-tab" role="status">
            <LoaderCircle size={13} />
            <span>
              <strong>{language === 'zh' ? '处理中' : 'Working'}</strong>
            </span>
          </div>
        )}
        {thinkingNotice && (
          <button
            className={`runtime-context-tab thinking-context-tab ${thinkingOpen ? 'open' : ''}`}
            type="button"
            title={thinkingNotice.preview}
            aria-expanded={thinkingOpen}
            onClick={() => {
              setChangesOpen(false);
              setCapabilitiesOpen(false);
              onToggleThinking();
            }}
          >
            <span className="runtime-tab-pulse" />
            <Brain size={12} />
            <span><strong>{language === 'zh' ? '思考中' : 'Thinking'}</strong></span>
          </button>
        )}
        {changeSummary && (
          <button
            className={`runtime-context-tab change-context-tab ${changesOpen ? 'open' : ''}`}
            type="button"
            title={language === 'zh' ? '查看本轮文件更改' : 'View file changes from this turn'}
            aria-expanded={changesOpen}
            onClick={() => {
              if (thinkingOpen) {
                onCloseThinking();
              }
              setCapabilitiesOpen(false);
              setChangesOpen((current) => !current);
            }}
          >
            <span className="runtime-tab-pulse" />
            <Code2 size={12} />
            <span>
              <strong>{running ? (language === 'zh' ? '更改中' : 'Changing') : (language === 'zh' ? '已更改' : 'Changed')}</strong>
              <small>
                {language === 'zh'
                  ? `${changeSummary.fileCount} 个文件 · 累计 ${changedLineCount} 行`
                  : `${changeSummary.fileCount} files · ${changedLineCount} lines total`}
              </small>
              {changeSummary.additions > 0 && <b className="diff-count add">+{changeSummary.additions}</b>}
              {changeSummary.deletions > 0 && <b className="diff-count del">-{changeSummary.deletions}</b>}
            </span>
          </button>
        )}
        {capabilityCandidates && (
          <button
            className={`runtime-context-tab capability-context-tab ${capabilitiesOpen ? 'open' : ''}`}
            type="button"
            title={language === 'zh' ? '查看本轮候选 Skill 和 Tool' : 'View candidate Skills and Tools'}
            aria-expanded={capabilitiesOpen}
            onClick={() => {
              if (thinkingOpen) {
                onCloseThinking();
              }
              setChangesOpen(false);
              setCapabilitiesOpen((current) => !current);
            }}
          >
            <Puzzle size={12} />
            <span>
              <strong>{language === 'zh' ? '能力建议' : 'Capabilities'}</strong>
              <small>
                {capabilityCandidates.skills.length} Skills · {capabilityCandidates.tools.length} Tools
              </small>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function mergeChangedFiles(reports: ConversationChangeReport[]): ToolFileChange[] {
  const byPath = new Map<string, ToolFileChange>();
  for (const report of reports) {
    for (const file of report.files) {
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, { ...file });
        continue;
      }
      existing.additions += file.additions;
      existing.deletions += file.deletions;
      if (file.diff) {
        existing.diff = existing.diff ? `${existing.diff}\n${file.diff}` : file.diff;
      }
      existing.lines.push(...file.lines);
    }
  }
  return [...byPath.values()];
}

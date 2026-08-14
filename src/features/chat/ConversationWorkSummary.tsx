import {
  CheckCircle2,
  Clock3,
  FileOutput,
  LoaderCircle,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { ShadowCloneIcon } from '../../components/ShadowCloneIcon';
import type { AppLanguage, ChatMessage } from '../../types';
import { AssistantLoopHistoryBlock } from '../chatMessages';
import {
  displayToolName,
  isToolRunning,
  summarizeChangeReports,
  type ConversationChangeReport,
} from '../tools';
import {
  ShadowTemporaryChat,
  type ShadowChatEntry,
} from './ShadowTemporaryChat';
import { ExperimentalA2APanel } from './ExperimentalA2APanel';

type WorkSummaryMode = 'summary' | 'a2a';

export function ConversationWorkSummary({
  language,
  sessionId,
  messages,
  changeReports,
  shadowAvailable,
  shadowOpen,
  shadowAgentName,
  shadowEntries,
  shadowBusy,
  shadowError,
  shadowAccentColor,
  onToggleShadow,
  onCloseShadow,
  onOpenChangeReview,
  requestedMode = 'summary',
  modeRequestId = 0,
  softVisible = true,
}: {
  language: AppLanguage;
  sessionId: string;
  messages: ChatMessage[];
  changeReports: ConversationChangeReport[];
  shadowAvailable: boolean;
  shadowOpen: boolean;
  shadowAgentName: string;
  shadowEntries: ShadowChatEntry[];
  shadowBusy: boolean;
  shadowError?: string;
  shadowAccentColor: string;
  onToggleShadow: () => void;
  onCloseShadow: () => void;
  onOpenChangeReview: () => void;
  requestedMode?: WorkSummaryMode;
  modeRequestId?: number;
  softVisible?: boolean;
}) {
  const [mode, setMode] = useState<WorkSummaryMode>('summary');
  const executions = useMemo(
    () => messages
      .flatMap((message) => [
        ...(message.toolExecutions ?? []),
        ...(message.loopHistory ?? []).flatMap((history) => history.toolExecutions ?? []),
      ])
      .filter((execution, index, all) =>
        all.findIndex((candidate) => candidate.id === execution.id) === index)
      .slice(-6)
      .reverse(),
    [messages],
  );
  const historyGroups = useMemo(
    () => messages
      .filter((message) => message.role === 'assistant' && (message.loopHistory?.length ?? 0) > 0)
      .map((message) => ({
        message,
        history: message.loopHistory ?? [],
      })),
    [messages],
  );
  const historyCount = useMemo(
    () => historyGroups.reduce((total, group) => total + group.history.length, 0),
    [historyGroups],
  );
  const changeSummary = useMemo(
    () => summarizeChangeReports(changeReports),
    [changeReports],
  );
  const recentFiles = useMemo(() => {
    const seen = new Set<string>();
    return [...changeReports]
      .reverse()
      .flatMap((report) => [...report.files].reverse())
      .filter((file) => {
        const key = file.path.trim().replaceAll('\\', '/').toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5);
  }, [changeReports]);

  useEffect(() => {
    setMode('summary');
  }, [sessionId]);

  useEffect(() => {
    if (!shadowOpen) setMode(requestedMode);
  }, [modeRequestId, requestedMode, shadowOpen]);

  useEffect(() => {
    if (shadowOpen) setMode('summary');
  }, [shadowOpen]);

  const handleShadow = () => {
    setMode('summary');
    onToggleShadow();
  };

  const handleA2A = () => {
    if (shadowOpen) onCloseShadow();
    setMode((current) => current === 'a2a' ? 'summary' : 'a2a');
  };

  return (
    <aside
      className={`conversation-work-summary soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}${shadowOpen ? ' shadow-mode' : ''}`}
      aria-hidden={!softVisible}
      style={{ '--shadow-accent': shadowAccentColor } as CSSProperties}
    >
      <nav className="work-summary-modes" aria-label={language === 'zh' ? '辅助会话' : 'Assistant channels'}>
        <button
          className={shadowOpen ? 'active shadow' : ''}
          type="button"
          disabled={!shadowAvailable}
          title={language === 'zh' ? 'Shadow 临时会话' : 'Shadow temporary chat'}
          onClick={handleShadow}
        >
          <ShadowCloneIcon size={16} />
          <span>Shadow</span>
        </button>
        <button
          className={mode === 'a2a' ? 'active' : ''}
          type="button"
          title={language === 'zh' ? 'A2A 协作 Agent' : 'A2A peer agent'}
          onClick={handleA2A}
        >
          <img className="a2a-official-icon" src="./a2a-icon.svg" alt="" aria-hidden="true" />
          <span>A2A</span>
        </button>
      </nav>

      <div className="work-summary-content">
        {shadowOpen ? (
          <div className="work-summary-shadow-chat">
            <ShadowTemporaryChat
              language={language}
              agentName={shadowAgentName}
              entries={shadowEntries}
              busy={shadowBusy}
              error={shadowError}
              open
              accentColor={shadowAccentColor}
              onClose={onCloseShadow}
            />
            <p className="work-summary-input-hint">
              {language === 'zh' ? '使用下方输入框继续临时会话' : 'Continue in the composer below'}
            </p>
          </div>
        ) : mode === 'a2a' ? (
          <ExperimentalA2APanel language={language} sessionId={sessionId} />
        ) : (
          <section className="work-summary-overview">
            <header>
              <span className="work-summary-kicker">{language === 'zh' ? '当前会话' : 'Current session'}</span>
              <h2>{language === 'zh' ? '工作摘要' : 'Work summary'}</h2>
            </header>

            {historyCount > 0 && (
              <div className="work-summary-section work-summary-history" data-testid="work-summary-history">
                <div className="work-summary-section-title">
                  <Clock3 size={13} />
                  <strong>{language === 'zh' ? '历史记录' : 'History'}</strong>
                  <span>{historyCount}</span>
                </div>
                <div className="work-summary-history-list">
                  {historyGroups.map(({ message, history }) => (
                    <AssistantLoopHistoryBlock
                      key={message.id}
                      history={history}
                      archivedPlan={message.taskPlan && !message.taskPlan.active
                        ? message.taskPlan
                        : undefined}
                      language={language}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="work-summary-section">
              <div className="work-summary-section-title">
                <Wrench size={13} />
                <strong>{language === 'zh' ? '工具执行' : 'Tool activity'}</strong>
                <span>{executions.length}</span>
              </div>
              {executions.length > 0 ? (
                <div className="work-summary-tool-list">
                  {executions.slice(0, 4).map((execution) => {
                    const running = isToolRunning(execution);
                    return (
                      <div className="work-summary-tool" key={execution.id}>
                        {running ? <LoaderCircle className="spin" size={12} /> : <CheckCircle2 size={12} />}
                        <span>
                          <strong>{displayToolName(execution.name)}</strong>
                          <small>{execution.summary || execution.output || (language === 'zh' ? '已完成' : 'Completed')}</small>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="work-summary-empty">{language === 'zh' ? '尚无工具执行' : 'No tool activity yet'}</p>
              )}
            </div>

            <div className="work-summary-section outputs">
              <div className="work-summary-section-title">
                <FileOutput size={13} />
                <strong>{language === 'zh' ? '最近产出' : 'Recent outputs'}</strong>
                {changeSummary && (
                  <button type="button" onClick={onOpenChangeReview}>
                    {changeSummary.fileCount}
                  </button>
                )}
              </div>
              {recentFiles.length > 0 ? (
                <div className="work-summary-file-list">
                  {recentFiles.map((file) => (
                    <button type="button" key={file.path} onClick={onOpenChangeReview}>
                      <span title={file.path}>{file.path.replaceAll('\\', '/').split('/').pop()}</span>
                      <small>
                        <b>+{file.additions}</b>
                        <i>-{file.deletions}</i>
                      </small>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="work-summary-empty">{language === 'zh' ? '尚无文件产出' : 'No outputs yet'}</p>
              )}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}

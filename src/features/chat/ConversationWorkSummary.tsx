import {
  CheckCircle2,
  ChevronDown,
  Clock3,
  FileCode2,
  FileOutput,
  LoaderCircle,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { AppLanguage, ChatMessage } from '../../types';
import { AssistantLoopHistoryBlock } from '../chatMessages';
import {
  displayToolName,
  isToolRunning,
  summarizeChangeReports,
  type ConversationChangeReport,
} from '../tools';
import { ExperimentalA2APanel } from './ExperimentalA2APanel';

export function ConversationWorkSummary({
  language,
  sessionId,
  messages,
  changeReports,
  onOpenChangeReview,
  softVisible = true,
}: {
  language: AppLanguage;
  sessionId: string;
  messages: ChatMessage[];
  changeReports: ConversationChangeReport[];
  onOpenChangeReview: () => void;
  softVisible?: boolean;
}) {
  const [a2aExpanded, setA2aExpanded] = useState(false);
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
    setA2aExpanded(false);
  }, [sessionId]);

  return (
    <aside
      className={`conversation-work-summary soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`}
      aria-hidden={!softVisible}
    >
      <div className="work-summary-content">
        <section className="work-summary-overview">
            <header className="work-summary-header">
              <div>
                <span className="work-summary-kicker">
                  {language === 'zh' ? '当前对话' : 'Current conversation'}
                </span>
                <h2>{language === 'zh' ? '工作摘要' : 'Work summary'}</h2>
              </div>
              <div className="work-summary-metrics">
                <span>{changeSummary?.fileCount ?? 0} {language === 'zh' ? '文件' : 'files'}</span>
                <span>{executions.length} {language === 'zh' ? '工具' : 'tools'}</span>
              </div>
            </header>

            <div className="work-summary-section outputs">
              <div className="work-summary-section-title">
                <FileOutput size={14} />
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
                      <FileCode2 size={14} />
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

            <div className="work-summary-section">
              <div className="work-summary-section-title">
                <Wrench size={14} />
                <strong>{language === 'zh' ? '工具执行' : 'Tool activity'}</strong>
                <span>{executions.length}</span>
              </div>
              {executions.length > 0 ? (
                <div className="work-summary-tool-list">
                  {executions.slice(0, 5).map((execution) => {
                    const running = isToolRunning(execution);
                    return (
                      <div className="work-summary-tool" key={execution.id}>
                        {running ? <LoaderCircle className="spin" size={13} /> : <CheckCircle2 size={13} />}
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

            {historyCount > 0 && (
              <div className="work-summary-section work-summary-history" data-testid="work-summary-history">
                <div className="work-summary-section-title">
                  <Clock3 size={14} />
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

            <div className="work-summary-section work-summary-a2a-section">
              <button
                className="work-summary-a2a-toggle"
                type="button"
                aria-expanded={a2aExpanded}
                onClick={() => setA2aExpanded((current) => !current)}
              >
                <img className="a2a-official-icon" src="./a2a-icon.svg" alt="" aria-hidden="true" />
                <span>
                  <strong>{language === 'zh' ? 'A2A 协作' : 'A2A collaboration'}</strong>
                  <small>{language === 'zh' ? '连接并派发远端 Agent 任务' : 'Connect and dispatch remote agent tasks'}</small>
                </span>
                <ChevronDown size={14} className={a2aExpanded ? 'expanded' : ''} />
              </button>
              {a2aExpanded && (
                <div className="work-summary-a2a-body">
                  <ExperimentalA2APanel language={language} />
                </div>
              )}
            </div>
        </section>
      </div>
    </aside>
  );
}

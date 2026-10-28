import { uiText } from '../../i18n';
import { ChevronDown, Clock3, FileText } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { prefersReducedMotion } from '../../shared/motionPreference';
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss';
import type { AppLanguage, ChatMessage } from '../../types';
import { AssistantLoopHistoryBlock } from '../chatMessages';
import { FileMemoScope } from '../chatMessages/FileMemoScope';
import type { WorkSummaryInspectorDetail } from '../subagents/subagentObservabilityEvents';
import { groupWorkSummaryHistoryByTurn, historyTurnLabel, historyTurnTimestamp } from './workSummaryHistory';

export function TurnHistoryInspector({
  detail,
  messages,
  language,
  active,
}: {
  detail: Extract<WorkSummaryInspectorDetail, { kind: 'turn-history' }>;
  messages: ChatMessage[];
  language: AppLanguage;
  active: boolean;
}) {
  const historyGroups = useMemo(() => groupWorkSummaryHistoryByTurn(messages), [messages]);
  const requestedTurnId = detail.turnId?.trim() || '';
  const groups = useMemo(() => requestedTurnId
    ? historyGroups.filter(group => (group.turnId || group.id) === requestedTurnId)
    : historyGroups, [historyGroups, requestedTurnId]);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [selectedTurnId, setSelectedTurnId] = useState('');
  const selectorId = useId();
  const scrollRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLElement | null>(null);
  const turnSelectorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const turnNodesRef = useRef(new Map<string, HTMLElement>());
  const appliedRequestRef = useRef<typeof detail | null>(null);
  const selectorContainers = useMemo(() => [turnSelectorRef], []);
  const closeSelector = useCallback((event?: Event) => {
    if (event instanceof KeyboardEvent && event.key === 'Escape') {
      triggerRef.current?.focus({ preventScroll: true });
    }
    setSelectorOpen(false);
  }, []);
  useOutsideDismiss(selectorOpen, selectorContainers, closeSelector);
  useEffect(() => { if (!active) closeSelector(); }, [active, closeSelector]);

  const jumpToTurn = useCallback((groupId: string, behavior: ScrollBehavior = 'smooth') => {
    const scroller = scrollRef.current;
    const turn = turnNodesRef.current.get(groupId);
    if (!scroller || !turn) return;
    scroller.scrollTo({
      top: scroller.scrollTop + turn.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top - (headingRef.current?.offsetHeight ?? 0) - 14,
      behavior: prefersReducedMotion() ? 'instant' : behavior,
    });
    setSelectedTurnId(groupId);
    setSelectorOpen(false);
  }, []);

  // Explicit requests switch between one turn and all details in this session's
  // tab. Tab activation alone must not reset the reader's position.
  useLayoutEffect(() => {
    if (!active || appliedRequestRef.current === detail) return;
    setSelectorOpen(false);
    if (requestedTurnId) {
      const group = groups[0];
      if (!group) return;
      jumpToTurn(group.id, 'instant');
    } else {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' });
      setSelectedTurnId('');
    }
    appliedRequestRef.current = detail;
  }, [active, detail, groups, jumpToTurn, requestedTurnId]);

  return (
    <section className="work-summary-inspector work-summary-turn-inspector" ref={scrollRef}>
      <header className="work-summary-inspector-heading" ref={headingRef}>
        <Clock3 size={17} />
        <div>
          <strong>{detail.title || (requestedTurnId
            ? uiText(language)('turnHistoryInspector.turnExecutionDetails')
            : uiText(language)('turnHistoryInspector.allTurnDetails'))}</strong>
          <small>
            {uiText(language)('turnHistoryInspector.messagesPlansAndToolActivity')}
          </small>
        </div>
        {groups.length > 1 && (
          <div className="work-summary-turn-selector" ref={turnSelectorRef}>
            <button type="button" ref={triggerRef}
              title={uiText(language)('turnHistoryInspector.quicklySelectATurn')}
              aria-expanded={selectorOpen} aria-haspopup="menu" aria-controls={selectorId}
              onClick={() => setSelectorOpen(open => !open)}>
              <span>{uiText(language)('turnHistoryInspector.selectTurn')}</span>
              <ChevronDown size={13} />
            </button>
            {selectorOpen && <div className="work-summary-turn-selector-menu" id={selectorId}
              role="menu" aria-label={uiText(language)('turnHistoryInspector.selectTurn')}>
              {groups.map((group) => (
                <button
                  type="button"
                  key={group.id}
                  title={group.prompt}
                  role="menuitem"
                  aria-current={selectedTurnId === group.id ? 'true' : undefined}
                  onClick={() => {
                    triggerRef.current?.focus({ preventScroll: true });
                    jumpToTurn(group.id);
                  }}
                >
                  <span>{historyTurnLabel(group, language)}</span>
                  {historyTurnTimestamp(group.message, language) && (
                    <small>{historyTurnTimestamp(group.message, language)}</small>
                  )}
                </button>
              ))}
            </div>}
          </div>
        )}
      </header>
      {groups.length > 0 ? (
        <div className="work-summary-inspector-turn-list">
          {groups.map((group) => (
            <article
              className="work-summary-inspector-turn"
              key={group.id}
              data-turn-id={group.id}
              ref={(node) => {
                if (node) turnNodesRef.current.set(group.id, node);
                else turnNodesRef.current.delete(group.id);
              }}
            >
              <header>
                <div>
                  <strong title={group.prompt}>{historyTurnLabel(group, language)}</strong>
                </div>
                <span>{historyTurnTimestamp(group.message, language)}</span>
              </header>
              <FileMemoScope sessionId={detail.sessionId} turnId={group.turnId || group.message.turnId}>
                <AssistantLoopHistoryBlock
                  history={group.history}
                  archivedPlan={group.message.taskPlan && !group.message.taskPlan.active
                    ? group.message.taskPlan
                    : undefined}
                  language={language}
                />
              </FileMemoScope>
            </article>
          ))}
        </div>
      ) : (
        <div className="work-summary-inspector-empty">
          <FileText size={18} />
          <span>{uiText(language)('turnHistoryInspector.noRecoverableExecutionDetailsForThisTurn')}</span>
        </div>
      )}
    </section>
  );
}

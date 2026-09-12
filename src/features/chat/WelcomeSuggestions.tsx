import { ArrowUpRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { RuntimeUserPrompt } from '@cardbush/bush-protocol';
import { fetchWelcomeHistory } from '../../backend/welcomeHistory';
import { buildWelcomeSuggestions } from './welcomeSuggestionRanking';

export function WelcomeSuggestions({ language, disabled, onSelect }: {
  language: 'zh' | 'en'; disabled: boolean; onSelect: (text: string) => void;
}) {
  const [history, setHistory] = useState<RuntimeUserPrompt[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false, lastRead = 0;
    const refresh = () => {
      if (document.hidden || pending || Date.now() - lastRead < 60000) return;
      pending = true;
      lastRead = Date.now();
      void fetchWelcomeHistory(controller.signal).then(rows => {
        if (!controller.signal.aborted) setHistory(rows);
      }).catch(() => { /* Suggestions are optional; the composer remains usable. */ })
        .finally(() => { pending = false; });
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const suggestions = useMemo(() => buildWelcomeSuggestions(history, language), [history, language]);
  const hasHistory = suggestions.some(item => item.fromHistory);
  return <div className="welcome-suggestions">
    <p className="welcome-suggestions-caption">{hasHistory
      ? language === 'zh' ? '从最近 7 天常聊的事开始' : 'Inspired by your last 7 days'
      : language === 'zh' ? '从一个想法开始' : 'Start with an idea'}</p>
    <div className="welcome-suggestions-list">
      {suggestions.map(item => <button key={item.text} type="button" className="welcome-suggestion"
        disabled={disabled} onClick={() => onSelect(item.text)} title={item.text}>
        <span className="welcome-suggestion-topic">{item.topic}<span>{item.fromHistory
          ? language === 'zh' ? '最近常聊' : 'Recent'
          : language === 'zh' ? '试一试' : 'Try this'}</span></span>
        <span className="welcome-suggestion-text">{item.text}</span>
        <ArrowUpRight className="welcome-suggestion-arrow" size={15} aria-hidden="true" />
      </button>)}
    </div>
  </div>;
}

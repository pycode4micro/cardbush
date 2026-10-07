import { useContext, useEffect, useState } from 'react';
import type { AppLanguage } from '../../types';
import { StarWordmark } from '../chat/StarWordmark';
import { WelcomeSuggestions } from '../chat/WelcomeSuggestions';
import { ComposerPresentationContext } from '../composer/ComposerPresentationContext';
import type { BuiltinComponent } from './componentModel';
import { HtmlComponentContext } from './HtmlComponentContext';
import { CalendarWidget } from '../automations/CalendarWidget';
import { isWindowVisible, watchWindowVisibility } from '../../shared/windowVisibility';

function useLocalTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      clearTimeout(timer);
      if (!isWindowVisible()) return;
      setNow(new Date());
      timer = setTimeout(tick, 1000 - Date.now() % 1000);
    };
    tick();
    const unwatchVisibility = watchWindowVisibility(tick);
    return () => { clearTimeout(timer); unwatchVisibility(); };
  }, []);
  return now;
}

function Clock({ digital, language }: { digital: boolean; language: AppLanguage }) {
  const now = useLocalTime(), locale = language === 'zh' ? 'zh-CN' : 'en-US';
  const time = now.toLocaleTimeString(locale, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = now.toLocaleDateString(locale, { month: 'long', day: 'numeric', weekday: 'long' });
  return <div className={`builtin-clock${digital ? ' digital' : ''}`}>
    {digital ? <time className="builtin-digital-time" dateTime={now.toISOString()}>{time}</time> :
      <svg className="builtin-clock-face" viewBox="0 0 200 200" role="img" aria-label={time}>
        <circle cx="100" cy="100" r="94" className="clock-rim"/>
        {Array.from({ length: 12 }, (_, index) => <line key={index} x1="100" y1="15" x2="100" y2={index % 3 === 0 ? 25 : 20} transform={`rotate(${index * 30} 100 100)`} className="clock-tick"/>)}
        <line x1="100" y1="100" x2="100" y2="54" transform={`rotate(${now.getHours() * 30 + now.getMinutes() / 2} 100 100)`} className="clock-hour"/>
        <line x1="100" y1="100" x2="100" y2="32" transform={`rotate(${now.getMinutes() * 6 + now.getSeconds() / 10} 100 100)`} className="clock-minute"/>
        <line x1="100" y1="115" x2="100" y2="27" transform={`rotate(${now.getSeconds() * 6} 100 100)`} className="clock-second"/>
        <circle cx="100" cy="100" r="4" fill="currentColor"/>
      </svg>}
    <span className="builtin-clock-date">{date}</span>
  </div>;
}

export function BuiltinComponentSurface({ component, language, preview = false }: { component: BuiltinComponent; language: AppLanguage; preview?: boolean }) {
  const host = useContext(HtmlComponentContext), zh = language === 'zh';
  switch (component.builtin) {
    case 'clock': return <Clock digital={false} language={language}/>;
    case 'digital-clock': return <Clock digital language={language}/>;
    case 'calendar': return <CalendarWidget language={language}/>;
    case 'brand': return <div className="builtin-brand"><StarWordmark/></div>;
    case 'greeting': return <div className="builtin-greeting"><h2>{zh ? '你想做些什么？' : 'What would you like to do?'}</h2></div>;
    case 'suggestions': return <div className="builtin-suggestions"><WelcomeSuggestions language={language} disabled={!host || host.running} hasDraft={Boolean(host?.draft?.trim())}
      onSelect={suggestion => host?.selectSuggestion ? host.selectSuggestion(suggestion) : host?.fill(suggestion.text)}/></div>;
    case 'input': return <div className={`builtin-input ${component.inputStyle ?? 'standard'}`}>
      <ComposerPresentationContext.Provider value={{ style: component.inputStyle ?? 'standard', preview }}>
        {host?.composer ?? <p className="builtin-unavailable">{zh ? '输入框将在会话就绪后可用' : 'The composer will be available when the conversation is ready'}</p>}
      </ComposerPresentationContext.Provider>
      {host?.notice && <p role="status" className="builtin-input-notice">{host.notice}</p>}
    </div>;
  }
}

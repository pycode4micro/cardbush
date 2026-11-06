import { useEffect, useState, type ReactNode } from 'react';
import { resolveUiLanguage, uiLanguages, uiText } from '../src/i18n';
import { UiLanguageProvider } from '../src/i18n/react';

const preferenceKey = 'cardbush-web-language';

function initialLanguage() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(preferenceKey); } catch { /* Storage may be disabled. */ }
  return resolveUiLanguage(saved || navigator.language);
}

/** The Web entry uses the same packs and React context as the desktop renderer. */
export function WebLanguage({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState(initialLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = uiText(language)('web.pageTitle');
  }, [language]);
  return <UiLanguageProvider language={language}>
    <label className="web-language">
      <span>{uiText(language)('web.language')}</span>
      <select aria-label={uiText(language)('web.language')} value={language} onChange={event => {
        const next = resolveUiLanguage(event.target.value);
        setLanguage(next);
        try { localStorage.setItem(preferenceKey, next); } catch { /* Keep the in-memory choice. */ }
      }}>
        {uiLanguages.map(item => <option key={item.locale} value={item.locale}>{item.name}</option>)}
      </select>
    </label>
    {children}
  </UiLanguageProvider>;
}

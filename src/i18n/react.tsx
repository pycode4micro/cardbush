import { createContext, useContext, type ReactNode } from 'react';
import { resolveUiLanguage } from './index';

const UiLanguageContext = createContext<string | undefined>(undefined);

/** Components without a language prop still update in the same render as the App. */
export function UiLanguageProvider({ language, children }: { language: string; children: ReactNode }) {
  return <UiLanguageContext.Provider value={language}>{children}</UiLanguageContext.Provider>;
}

export function useUiLanguage() {
  return useContext(UiLanguageContext) ?? resolveUiLanguage(typeof document === 'undefined' ? 'en' : document.documentElement.lang);
}

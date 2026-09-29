import { createContext, type ReactNode } from 'react';
import type { WelcomeSuggestion } from '../chat/welcomeSuggestionRanking';
export type HtmlComponentHost = {
  revision: string; sessionId: string; language: string; running: boolean;
  fill: (text: string) => void; send: (text: string) => Promise<void | boolean>; openBrowser: (url: string) => void;
  // Trusted built-in views only; these bindings are never sent to HTML frames.
  composer?: ReactNode; draft?: string; notice?: string;
  selectSuggestion?: (suggestion: WelcomeSuggestion) => void;
};
export const HtmlComponentContext = createContext<HtmlComponentHost | null>(null);

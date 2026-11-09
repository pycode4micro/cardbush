import { createContext } from 'react';
export type HtmlComponentHost = {
  revision: string; sessionId: string; language: string; running: boolean;
  fill: (text: string) => void; send: (text: string) => Promise<void | boolean>; openBrowser: (url: string) => void;
};
export const HtmlComponentContext = createContext<HtmlComponentHost | null>(null);

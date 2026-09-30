export type TranslationLanguage = 'zh' | 'en';
export type TranslationText = { id: string; text: string };
export type BrowserTranslationRequest = {
  guestWebContentsId: number;
  action: 'translate' | 'restore';
  language: TranslationLanguage;
};
export type BrowserTranslationError = 'unavailable' | 'no_text' | 'model' | 'timeout' | 'failed';
export type BrowserTranslationResult = {
  status: 'original' | 'translated' | 'error';
  language?: TranslationLanguage;
  partial?: boolean;
  error?: BrowserTranslationError;
};
export type BrowserTranslationState = Omit<BrowserTranslationResult, 'status'> & {
  status: BrowserTranslationResult['status'] | 'translating';
};

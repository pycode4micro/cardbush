import { uiText } from '../../i18n';
import type { InspectorOpenDetail } from '../inspector/inspectorEvents';
import type { AppLanguage } from '../../types';

export function newBrowserTab(language: AppLanguage = 'zh'): InspectorOpenDetail {
  return { target: 'about:blank', title: uiText(language)('browserStartPage.newTab'), newTab: true };
}

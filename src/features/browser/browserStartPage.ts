import type { InspectorOpenDetail } from '../inspector/inspectorEvents';
import type { AppLanguage } from '../../types';

export function newBrowserTab(language: AppLanguage = 'zh'): InspectorOpenDetail {
  return { target: 'about:blank', title: language === 'zh' ? '新标签页' : 'New tab', newTab: true };
}

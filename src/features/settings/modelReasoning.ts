import type { AppLanguage, ReasoningLevel } from '../../types';

export function modelReasoningLabel(level: ReasoningLevel, language: AppLanguage) {
  const labels: Record<ReasoningLevel, { zh: string; en: string }> = {
    default: { zh: '服务商默认', en: 'Provider default' },
    none: { zh: '关闭', en: 'None' }, low: { zh: '低', en: 'Low' }, medium: { zh: '中', en: 'Medium' },
    high: { zh: '高', en: 'High' }, xhigh: { zh: '超高', en: 'Extra high' }, max: { zh: '最高', en: 'Max' },
  };
  return labels[level][language];
}

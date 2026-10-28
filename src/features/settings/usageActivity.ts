import { uiText } from '../../i18n';
export type { UsageStatistics as CumulativeUsageStatistics } from '../../../electron/usageLedger';

export async function loadCumulativeUsageStatistics() {
  if (!window.cardbushDesktop?.usageStatistics) throw new Error(uiText()('usageActivity.usage_recording_requires_the_desktop_host'));
  return window.cardbushDesktop.usageStatistics();
}

export type { UsageStatistics as CumulativeUsageStatistics } from '../../../electron/usageLedger';

export async function loadCumulativeUsageStatistics() {
  if (!window.cardbushDesktop?.usageStatistics) throw new Error('Usage recording requires the desktop host.');
  return window.cardbushDesktop.usageStatistics();
}

import { uiText } from '../../i18n';
export function marketRetryAt(value: string): number | undefined {
  const match = value.match(/\[market-rate-limit:(\d{1,16})\]/);
  const time = match ? Number(match[1]) : NaN;
  return Number.isFinite(time) && time > 0 && time <= 8.64e15 ? time : undefined;
}

export function networkError(value: string) {
  return /ERR_(CONNECTION|NETWORK|PROXY|TUNNEL|NAME)|ECONNRESET|fetch failed|timed? ?out|timeout/i.test(value);
}

export function marketRateLimited(value: string) {
  return /\[market-rate-limit:(?:\d{1,16}|unknown)\]|HTTP 429\b/.test(value);
}

export function marketError(value: string, uiLanguage: string, now = Date.now()) {
  if (/\[market-disk-space\]|ENOSPC/.test(value)) return uiText(uiLanguage)('pluginMarketErrors.notEnoughDiskSpaceToDownloadOr');
  if (value.includes('[market-expanded-size]')) return uiText(uiLanguage)('pluginMarketErrors.theSelectedPluginExceedsTheExtractedLimits');
  const retryAt = marketRetryAt(value);
  if (marketRateLimited(value)) {
    const seconds = retryAt === undefined ? undefined : Math.max(0, Math.ceil((retryAt - now) / 1000));
    if (seconds === undefined) return uiText(uiLanguage)('pluginMarketErrors.theMarketplaceLimitedThisRequestWithoutA');
    if (seconds === 0) return uiText(uiLanguage)('pluginMarketErrors.theServerSRetryTimeHasPassed');
    return uiText(uiLanguage)('pluginMarketErrors.theServerAsksThisNetworkToRetry', { value1: seconds });
  }
  if (networkError(value)) return uiText(uiLanguage)('pluginMarketErrors.cannotReachTheMarketplaceRetryOrCheck');
  return value.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}

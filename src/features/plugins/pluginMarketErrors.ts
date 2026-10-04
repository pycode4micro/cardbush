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

export function marketError(value: string, zh: boolean, now = Date.now()) {
  if (/\[market-disk-space\]|ENOSPC/.test(value)) return zh ? '磁盘空间不足，无法下载或解压插件。请释放空间后重试。' : 'Not enough disk space to download or extract the plugin. Free some space and retry.';
  if (value.includes('[market-expanded-size]')) return zh ? '目标插件解压后的内容超过限制：单文件 16 MiB、合计 64 MiB。此限制只计算所选插件，不计算仓库中的其他文件。' : 'The selected plugin exceeds the extracted limits: 16 MiB per file, 64 MiB total. Unrelated repository files do not count.';
  const retryAt = marketRetryAt(value);
  if (marketRateLimited(value)) {
    const seconds = retryAt === undefined ? undefined : Math.max(0, Math.ceil((retryAt - now) / 1000));
    if (seconds === undefined) return zh ? '市场服务限制了请求，但未提供恢复时间。本次请求已结束，未自动重试；可稍后手动重试。' : 'The marketplace limited this request without a reset time. The request has ended without automatic retries; try again later.';
    if (seconds === 0) return zh ? '服务端给出的等待时间已结束，可以重试。' : 'The server’s retry time has passed. You can retry.';
    return zh ? `服务端要求当前网络约 ${seconds} 秒后可重试。CardBush 不额外延长等待；更改代理后可重试，已加载的列表仍可浏览。`
      : `The server asks this network to retry in about ${seconds}s. CardBush adds no extra delay. You can retry after changing the proxy and keep browsing the loaded list.`;
  }
  if (networkError(value)) return zh ? '暂时无法连接市场。请重试，或检查代理设置；使用代理访问 GitHub 时，需要在 CardBush 中选择对应的代理方式。' : 'Cannot reach the marketplace. Retry or check CardBush proxy settings for GitHub access.';
  return value.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}

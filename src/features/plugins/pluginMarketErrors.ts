export function marketRetryAt(value: string): number | undefined {
  const match = value.match(/\[market-rate-limit:(\d{1,16})\]/);
  const time = match ? Number(match[1]) : NaN;
  return Number.isFinite(time) && time > 0 && time <= 8.64e15 ? time : undefined;
}

export function networkError(value: string) {
  return /ERR_(CONNECTION|NETWORK|PROXY|TUNNEL|NAME)|ECONNRESET|fetch failed|timed? ?out|timeout/i.test(value);
}

export function marketError(value: string, zh: boolean, now = Date.now()) {
  const retryAt = marketRetryAt(value);
  if (retryAt !== undefined || /HTTP 429\b/.test(value)) {
    const seconds = retryAt === undefined ? undefined : Math.max(0, Math.ceil((retryAt - now) / 1000));
    if (seconds === undefined) return zh ? '市场服务暂时限制了请求，请稍后重试。你仍可浏览已加载的插件列表。' : 'The marketplace is rate limiting requests. Try again later; you can still browse the loaded list.';
    if (seconds === 0) return zh ? '请求等待时间已结束，可以重试获取插件。' : 'The waiting period has ended. You can retry the download.';
    return zh ? `市场服务暂时限制了请求，约 ${seconds} 秒后可重试。等待期间已暂停向该服务发送新请求，你仍可浏览市场。`
      : `The marketplace is rate limiting requests. Retry in about ${seconds}s. New requests to this service are paused; you can still browse the marketplace.`;
  }
  if (networkError(value)) return zh ? '暂时无法连接市场。请重试，或检查代理设置；使用代理访问 GitHub 时，需要在 CardBush 中选择对应的代理方式。' : 'Cannot reach the marketplace. Retry or check CardBush proxy settings for GitHub access.';
  return value.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}

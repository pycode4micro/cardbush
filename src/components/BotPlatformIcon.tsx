import type { BotPlatform } from '../types';

export function BotPlatformIcon({
  platform,
}: {
  platform: BotPlatform | 'any';
}) {
  if (platform === 'weixin') {
    return (
      <span className="brand-platform-icon weixin" aria-hidden="true">
        <svg viewBox="0 0 32 32" role="img">
          <path d="M13.4 7.1C7.6 7.1 3 10.8 3 15.4c0 2.6 1.5 5 3.9 6.5l-.8 2.8 3.4-1.6c1.2.4 2.5.7 3.9.7 5.7 0 10.4-3.7 10.4-8.3S19.1 7.1 13.4 7.1Z" />
          <path d="M19.6 13.3c5.1 0 9.2 3.2 9.2 7.2 0 2.2-1.2 4.2-3.3 5.5l.7 2.5-3-1.4c-1.1.4-2.3.6-3.6.6-5.1 0-9.2-3.2-9.2-7.2s4.1-7.2 9.2-7.2Z" />
          <circle cx="10.1" cy="14.1" r="1.1" />
          <circle cx="16.4" cy="14.1" r="1.1" />
          <circle cx="16.6" cy="20.1" r="0.9" />
          <circle cx="22" cy="20.1" r="0.9" />
        </svg>
      </span>
    );
  }
  if (platform === 'feishu') {
    return (
      <span className="brand-platform-icon feishu" aria-hidden="true">
        <svg viewBox="0 0 32 32" role="img">
          <rect x="13.5" y="2.8" width="7.3" height="15.6" rx="3.65" transform="rotate(36 17.2 10.6)" />
          <rect x="18.1" y="10.2" width="7.3" height="15.6" rx="3.65" transform="rotate(88 21.7 18)" />
          <rect x="11.2" y="13.7" width="7.3" height="15.6" rx="3.65" transform="rotate(144 14.9 21.5)" />
          <rect x="5.9" y="6.8" width="7.3" height="15.6" rx="3.65" transform="rotate(-91 9.6 14.6)" />
          <circle cx="16" cy="16" r="3.25" />
        </svg>
      </span>
    );
  }
  if (platform === 'discord') {
    return (
      <span className="brand-platform-icon discord" aria-hidden="true">
        <svg viewBox="0 0 32 32" role="img">
          <path d="M9.1 9.3c2.1-1 4.4-1.5 6.9-1.5s4.8.5 6.9 1.5c2.1 3.1 3.1 6.6 2.8 10.5-2.3 1.7-4.5 2.7-6.7 3l-.9-1.7c1.1-.3 2.1-.8 3.1-1.4-.3-.2-.6-.4-.9-.6-2.8 1.3-5.8 1.3-8.6 0-.3.2-.6.4-.9.6 1 .6 2 1.1 3.1 1.4l-.9 1.7c-2.2-.3-4.4-1.3-6.7-3-.3-3.9.7-7.4 2.8-10.5Z" />
          <circle cx="12.7" cy="16.1" r="1.55" />
          <circle cx="19.3" cy="16.1" r="1.55" />
        </svg>
      </span>
    );
  }
  if (platform === 'telegram') {
    return (
      <span className="brand-platform-icon telegram" aria-hidden="true">
        <svg viewBox="0 0 32 32" role="img">
          <circle cx="16" cy="16" r="13" />
          <path d="M22.9 9.4 7.8 15.2c-1 .4-1 1 0 1.3l3.8 1.2 1.5 4.7c.2.7.5.9 1 .3l2.2-2.1 4.5 3.3c.8.5 1.4.3 1.6-.8l2.8-12.8c.3-1.2-.5-1.4-1.3-.9Z" />
          <path d="m12.2 17.4 8.8-5.5c.4-.2.7-.1.4.2l-7.1 6.5-.3 3.1-1.8-4.3Z" />
        </svg>
      </span>
    );
  }
  return (
    <span className="brand-platform-icon any" aria-hidden="true">
      <svg viewBox="0 0 32 32" role="img">
        <circle cx="10.4" cy="10.5" r="4.1" />
        <circle cx="21.6" cy="10.5" r="4.1" />
        <circle cx="10.4" cy="21.5" r="4.1" />
        <circle cx="21.6" cy="21.5" r="4.1" />
      </svg>
    </span>
  );
}

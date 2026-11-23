import type { MessageKey } from '@cardbush/platform/i18n';

/** Carry the native browser's own failures in the library and translate at IPC. */
export class BrowserUiError extends Error {
  constructor(readonly key: Extract<MessageKey, `browserNative.${string}`>) {
    super(key);
  }
}

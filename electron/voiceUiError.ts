import { uiText, type MessageKey, type MessageVariables } from '@cardbush/platform/i18n';

export type NativeVoiceMessage = Extract<MessageKey, `voiceNative.${string}`>;

export class NativeVoiceError extends Error {
  constructor(readonly key: NativeVoiceMessage, readonly variables?: MessageVariables) {
    super(key);
  }

  describe(language: string): string {
    return uiText(language)(this.key, this.variables);
  }
}

export function windowsVoiceError(code: unknown, legacyMessage: unknown): Error {
  if (typeof code === 'string' && code.startsWith('voiceNative.windows')) {
    const key = code as NativeVoiceMessage;
    try {
      uiText('en')(key);
      return new NativeVoiceError(key);
    } catch { /* An unknown result from a mismatched helper is a generic failure. */ }
  }
  if (code === undefined && typeof legacyMessage === 'string' && legacyMessage) return new Error(legacyMessage);
  return new NativeVoiceError('voiceNative.windowsRunFailed');
}

import { uiText, type MessageKey, type MessageVariables } from '@cardbush/platform/i18n';

/** Keep application-owned status as a message reference until a reader chooses a locale. */
export class RuntimeUiError extends Error {
  constructor(readonly messageKey: MessageKey, readonly variables?: MessageVariables, language?: string) {
    super(uiText(language)(messageKey, variables));
  }
  localize(language: string) { return uiText(language)(this.messageKey, this.variables); }
}

export function retainedRuntimeError(error: unknown): string | RuntimeUiError {
  return error instanceof RuntimeUiError ? error : error instanceof Error ? error.message : String(error);
}

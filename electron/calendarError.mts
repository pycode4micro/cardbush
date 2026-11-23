import { uiText, type MessageKey, type MessageVariables } from '@cardbush/platform/i18n';

type CalendarErrorKey = Extract<MessageKey, `calendarError.${string}`>;
export type CalendarFailure = { key: CalendarErrorKey; variables?: MessageVariables };

export class CalendarError extends Error {
  readonly failure: CalendarFailure;

  constructor(key: CalendarErrorKey, variables?: MessageVariables) {
    super(key);
    this.failure = { key, variables };
  }

  describe(language: string) {
    return uiText(language)(this.failure.key, this.failure.variables);
  }
}

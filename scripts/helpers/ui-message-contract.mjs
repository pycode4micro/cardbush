import assert from 'node:assert/strict';
import { uiText } from '@cardbush/platform/i18n';

// Source contracts verify the message key; UI suites verify its rendered use.
// Check both shipped translations here instead of requiring inline bilingual UI.
export function assertUiMessage(source, key, translations, variables = {}) {
  assert.ok(source.includes(`'${key}'`) || source.includes(`"${key}"`), `Missing UI message reference: ${key}`);
  for (const [language, expected] of Object.entries(translations)) {
    assert.equal(uiText(language)(key, variables), expected, `${language}: ${key}`);
  }
}

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function languageChunkGroups() {
  const directory = new URL('../src/i18n/locales/', import.meta.url);
  return readdirSync(fileURLToPath(directory)).filter(file => file.endsWith('.json')).map(file => {
    const { locale } = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
    const canonical = Intl.getCanonicalLocales(locale)[0];
    return {
      name: `ui-language-${canonical}`,
      test: new RegExp(`[\\\\/]i18n[\\\\/]generatedPacks[\\\\/]${canonical}\\.js$`),
      priority: 40,
      entriesAware: true,
    };
  });
}

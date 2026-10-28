export type Message = string | Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type LanguagePack = { locale: string; name: string; messages: Record<string, Message> };
export type MessageVariables = Record<string, unknown>;

/** Data-only language packs; missing locales and messages use the default pack. */
export function createMessageCatalog(packs: LanguagePack[], defaultLocale = 'en') {
  const languages = new Map<string, LanguagePack>();
  for (const pack of packs) {
    const locale = Intl.getCanonicalLocales(pack.locale)[0];
    if (languages.has(locale)) throw new Error(`Duplicate language pack: ${locale}`);
    languages.set(locale, pack);
  }
  const fallback = languages.get(defaultLocale);
  if (!fallback) throw new Error(`Missing default language pack: ${defaultLocale}`);
  function resolve(language: unknown): LanguagePack {
    if (typeof language !== 'string') return fallback!;
    let locale: string;
    try { locale = Intl.getCanonicalLocales(language)[0] ?? defaultLocale; }
    catch { return fallback!; }
    while (locale) {
      const pack = languages.get(locale);
      if (pack) return pack;
      locale = locale.slice(0, Math.max(0, locale.lastIndexOf('-')));
    }
    return fallback!;
  }
  return {
    languages: packs.map(({ locale, name }) => ({ locale, name })),
    resolve: (language: unknown) => resolve(language).locale,
    list(language: string, items: string[]) {
      return new Intl.ListFormat(resolve(language).locale, { style: 'short', type: 'conjunction' }).format(items);
    },
    text(language: string, key: string, variables: MessageVariables = {}) {
      const selected = resolve(language);
      const pack = Object.hasOwn(selected.messages, key) ? selected : fallback;
      const message = Object.hasOwn(pack.messages, key) ? pack.messages[key] : undefined;
      if (message === undefined) throw new Error(`Unknown UI message: ${key}`);
      let template: string;
      if (typeof message === 'string') template = message;
      else {
        const count = variables.count;
        if (typeof count !== 'number' || !Number.isFinite(count)) throw new Error(`UI message ${key} requires a numeric count`);
        template = message[new Intl.PluralRules(pack.locale).select(count)] ?? message.other;
      }
      return template.replace(/\{\{|\}\}|\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
        if (match === '{{') return '{';
        if (match === '}}') return '}';
        if (!Object.hasOwn(variables, name)) throw new Error(`Missing UI message variable: ${key}.${name}`);
        return String(variables[name]);
      });
    },
  };
}

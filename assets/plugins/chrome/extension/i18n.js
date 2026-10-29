// Generated from src/i18n/locales/*.json by scripts/build-browser-extension.mjs.
globalThis.CardBushExtensionI18n = (() => {
const exports = {};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMessageCatalog = createMessageCatalog;
/** Data-only language packs; missing locales and messages use the default pack. */
function createMessageCatalog(packs, defaultLocale = 'en') {
    const languages = new Map();
    for (const pack of packs) {
        const locale = Intl.getCanonicalLocales(pack.locale)[0];
        if (languages.has(locale))
            throw new Error(`Duplicate language pack: ${locale}`);
        languages.set(locale, pack);
    }
    const fallback = languages.get(defaultLocale);
    if (!fallback)
        throw new Error(`Missing default language pack: ${defaultLocale}`);
    function resolve(language) {
        if (typeof language !== 'string')
            return fallback;
        let locale;
        try {
            locale = Intl.getCanonicalLocales(language)[0] ?? defaultLocale;
        }
        catch {
            return fallback;
        }
        while (locale) {
            const pack = languages.get(locale);
            if (pack)
                return pack;
            locale = locale.slice(0, Math.max(0, locale.lastIndexOf('-')));
        }
        return fallback;
    }
    return {
        languages: packs.map(({ locale, name }) => ({ locale, name })),
        resolve: (language) => resolve(language).locale,
        list(language, items) {
            return new Intl.ListFormat(resolve(language).locale, { style: 'short', type: 'conjunction' }).format(items);
        },
        text(language, key, variables = {}) {
            const selected = resolve(language);
            const pack = Object.hasOwn(selected.messages, key) ? selected : fallback;
            const message = Object.hasOwn(pack.messages, key) ? pack.messages[key] : undefined;
            if (message === undefined)
                throw new Error(`Unknown UI message: ${key}`);
            let template;
            if (typeof message === 'string')
                template = message;
            else {
                const count = variables.count;
                if (typeof count !== 'number' || !Number.isFinite(count))
                    throw new Error(`UI message ${key} requires a numeric count`);
                template = message[new Intl.PluralRules(pack.locale).select(count)] ?? message.other;
            }
            return template.replace(/\{\{|\}\}|\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name) => {
                if (match === '{{')
                    return '{';
                if (match === '}}')
                    return '}';
                if (!Object.hasOwn(variables, name))
                    throw new Error(`Missing UI message variable: ${key}.${name}`);
                return String(variables[name]);
            });
        },
    };
}

const catalog = exports.createMessageCatalog([{"locale":"en","name":"English","messages":{"browser.extension.connectionHelp":"Confirm the first local connection once in the CardBush extension window; no pairing code is needed. The local App and CLI then share this connection. After three fast attempts, saved connections retry every 30 seconds without another approval. Browser suspension can delay recovery. New enrollment stops after three failures. Remote Agents keep separate connections. Personal tabs still require copying into the session group; denial or removal never triggers automatic reauthorization."}},{"locale":"zh","name":"中文","messages":{"browser.extension.connectionHelp":"本机首次在 CardBush 风格的扩展窗口确认一次连接，无需复制配对码。之后本机 App 和 CLI 共用连接。已保存的连接在 3 次快速尝试后，每 30 秒自动重连，无需再次授权；浏览器休眠可能延迟恢复。首次注册连续失败 3 轮后停止。远程 Agent 独立管理连接。个人标签仍需明确复制进会话隔离组；拒绝或移除连接后不会自动重新授权。"}}]);
return { uiText: language => (key, variables) => catalog.text(language, key, variables) };
})();

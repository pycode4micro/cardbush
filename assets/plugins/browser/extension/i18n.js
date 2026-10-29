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

const catalog = exports.createMessageCatalog([{"locale":"en","name":"English","messages":{"browser.extension.connectionHelp":"Confirm the first local connection once in the CardBush extension window; no pairing code is needed. The local App and CLI then share this connection. After three fast attempts, saved connections retry every 30 seconds without another approval. Browser suspension can delay recovery. New enrollment stops after three failures. Remote Agents keep separate connections. Personal tabs still require copying into the session group; denial or removal never triggers automatic reauthorization.","browser.extension.retry":"Retry saved connection","browser.extension.connect":"Connect CardBush","browser.extension.advanced":"Advanced connection / change pairing","browser.extension.repairHelp":"Pair again only to replace the local connection, then confirm in the extension window. Exiting, restarting or temporarily going offline restores the saved connection automatically without another approval.","browser.extension.repair":"Pair local connection again","browser.extension.stale":"The extension background is still running an older build. Reload the extension.","browser.extension.stopped":"Local enrollment has stopped. The original pairing and site permissions are saved. Click Connect CardBush when ready to continue.","browser.extension.removed":"The connection was removed. Click Connect CardBush to connect locally, or pair another Agent in advanced connection.","browser.extension.disabled":"The extension connection is disabled. Pairing and site permissions are saved. Click Connect to resume.","browser.extension.controlling":"Controlling {count} tabs","browser.extension.connected":"Connected to CardBush, waiting for control","browser.extension.opening":"Connecting to CardBush with saved authorization…","browser.extension.handshake":"Endpoint found; verifying CardBush identity…","browser.extension.authentication":"CardBush identity verified; restoring the authorized connection…","browser.extension.enrolling":"Requesting a local connection. Confirm once in the extension window.","browser.extension.paused":"Enrollment failed repeatedly and automatic requests have stopped. Click Connect when ready to retry.","browser.extension.waiting":"CardBush is temporarily offline. Retrying the saved connection in about {seconds} seconds; no new approval is needed.","browser.extension.retrying":"Waiting to restore the saved connection. Make sure CardBush is running with Browser Use enabled. Pairing again is unnecessary.","browser.extension.enrollmentRetry":"Local enrollment is incomplete; waiting for a limited retry. Make sure CardBush is running with Browser Use enabled."}},{"locale":"zh","name":"中文","messages":{"browser.extension.connectionHelp":"本机首次在 CardBush 风格的扩展窗口确认一次连接，无需复制配对码。之后本机 App 和 CLI 共用连接。已保存的连接在 3 次快速尝试后，每 30 秒自动重连，无需再次授权；浏览器休眠可能延迟恢复。首次注册连续失败 3 轮后停止。远程 Agent 独立管理连接。个人标签仍需明确复制进会话隔离组；拒绝或移除连接后不会自动重新授权。","browser.extension.retry":"重试已保存的连接","browser.extension.connect":"连接 CardBush","browser.extension.advanced":"高级连接 / 更换配对","browser.extension.repairHelp":"仅在需要更换本机连接时重新配对，并在扩展窗口确认。普通退出、重启或临时离线会自动恢复原连接，无需再次授权。","browser.extension.repair":"重新配对本机连接","browser.extension.stale":"扩展后台仍在运行旧版本，需要重新加载。","browser.extension.stopped":"本机连接申请已停止，原配对与网站授权已保留。准备好后点击「连接 CardBush」继续申请。","browser.extension.removed":"连接已移除。点击「连接 CardBush」重新连接本机，或在高级连接中配对其他 Agent。","browser.extension.disabled":"扩展连接已关闭，配对与网站授权已保留。点击连接即可恢复。","browser.extension.controlling":"正在控制 {count} 个标签页","browser.extension.connected":"已连接 CardBush，等待控制","browser.extension.opening":"正在使用已保存的授权连接 CardBush…","browser.extension.handshake":"已找到连接端点，正在校验 CardBush 身份…","browser.extension.authentication":"CardBush 身份已验证，正在恢复已授权连接…","browser.extension.enrolling":"正在申请本机连接，请在扩展弹窗中确认一次。","browser.extension.paused":"连接申请连续失败，已停止自动申请。准备好后点击连接重试。","browser.extension.waiting":"CardBush 暂时离线，将在约 {seconds} 秒后重试已保存的连接，无需再次授权。","browser.extension.retrying":"正在等待恢复已保存的连接。请确认 CardBush 已启动并启用 Browser Use，无需重新配对。","browser.extension.enrollmentRetry":"本机连接申请未完成，等待有限重试。请确认 CardBush 已启动并启用 Browser Use。"}}]);
return { uiText: language => (key, variables) => catalog.text(language, key, variables) };
})();

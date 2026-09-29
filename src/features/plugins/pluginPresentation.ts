import type { AppLanguage, CardbushAppPlugin } from '../../types';

/** Localize display text without changing the catalog or saved plugin configuration. */
export function pluginPresentation(plugin: CardbushAppPlugin, language: AppLanguage) {
  const localized = plugin.localizations?.[language];
  return {
    description: localized?.description ?? plugin.description,
    longDescription: localized?.longDescription ?? plugin.longDescription,
    defaultPrompts: localized?.defaultPrompts ?? plugin.defaultPrompts,
  };
}

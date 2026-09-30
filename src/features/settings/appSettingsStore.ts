import { defaultHostTerminalRuntime, normalizeHostTerminalRuntime } from '../../backend/hostPlatform';
import { type AppSettingsState, type CompanionMotionMode, type CompanionSettings, type CompanionSize, type TerminalRuntime } from '../../types';
import { APPEARANCE_STORAGE_KEY, normalizeAppearance, readAppearance } from '../appearance/appearancePreferences';
import { normalizeImportedThemeStyle } from '../appearance/importedThemeStyle';
import { importedThemeStyleStorageKey, readImportedThemeStyle } from '../appearance/themePreferences';
import { normalizeConversationStylePreferences, readConversationStyle, saveConversationStyle } from './conversationStyle';
import { normalizeIndividuation, readIndividuation, saveIndividuation } from './individuation';
import { normalizeManagedModelConfigs, readManagedModelConfigs } from './modelPreferences';

const defaultAppSettings: AppSettingsState = {
  conversationStyle: normalizeConversationStylePreferences(undefined),
  individuation: normalizeIndividuation(undefined),
  proxy: {
    mode: 'none',
    httpProxy: '',
    httpsProxy: '',
    noProxy: '127.0.0.1,localhost,::1',
  },
  browser: {
    privacyMode: false,
  },
  thinking: {
    visible: false,
  },
  guidance: {
    deliveryMode: 'queue',
  },
  terminal: {
    runtime: defaultHostTerminalRuntime(),
  },
  managedModelConfigs: [],
  importedThemeStyle: null,
  companionEnabled: true,
  companion: {
    size: 'normal',
    opacity: 0.95,
    motion: 'full',
  },
  font: {
    family: '',
    displayName: '',
    filePath: '',
  },
  user: {
    name: '访客',
    membership: 'Free',
    avatarEmoji: '🍃',
    avatarImagePath: '',
  },
};

export function readInitialAppSettings(): AppSettingsState {
  return normalizeAppSettings({
    appearance: readAppearance(),
    conversationStyle: readConversationStyle(),
    individuation: readIndividuation(),
    proxy: {
      mode: proxyModeFromStorage(
        window.localStorage.getItem('cardbush_proxy_mode'),
        window.localStorage.getItem('cardbush_proxy_http') ?? '',
        window.localStorage.getItem('cardbush_proxy_https') ?? '',
      ),
      httpProxy: window.localStorage.getItem('cardbush_proxy_http') ?? '',
      httpsProxy: window.localStorage.getItem('cardbush_proxy_https') ?? '',
      noProxy:
        window.localStorage.getItem('cardbush_proxy_no_proxy') ??
        '127.0.0.1,localhost,::1',
    },
    browser: {
      privacyMode:
        window.localStorage.getItem('cardbush_browser_privacy_mode') === 'true',
    },
    thinking: {
      visible: window.localStorage.getItem('cardbush_thinking_visible') === 'true',
    },
    guidance: {
      deliveryMode:
        window.localStorage.getItem('cardbush_guidance_delivery_mode') === 'immediate'
          ? 'immediate'
          : 'queue',
    },
    terminal: {
      runtime: terminalRuntimeFromStorage(
        window.localStorage.getItem('cardbush_terminal_runtime'),
      ),
    },
    managedModelConfigs: readManagedModelConfigs(),
    importedThemeStyle: readImportedThemeStyle(),
    companionEnabled:
      window.localStorage.getItem('cardbush_cardling_enabled') !== 'false',
    companion: readCompanionSettings(),
    font: {
      family: window.localStorage.getItem('cardbush_font_family') ?? '',
      displayName: window.localStorage.getItem('cardbush_font_display_name') ?? '',
      filePath: window.localStorage.getItem('cardbush_font_file_path') ?? '',
    },
    user: {
      name:
        window.localStorage.getItem('cardbush_user_name') ??
        defaultAppSettings.user.name,
      membership:
        window.localStorage.getItem('cardbush_user_membership') ??
        defaultAppSettings.user.membership,
      avatarEmoji:
        window.localStorage.getItem('cardbush_user_avatar') ??
        defaultAppSettings.user.avatarEmoji,
      avatarImagePath: window.localStorage.getItem('cardbush_user_avatar_image') ?? '',
    },
  });
}

export function normalizeAppSettings(settings: AppSettingsState): AppSettingsState {
  const httpProxy = settings.proxy.httpProxy.trim();
  const httpsProxy = settings.proxy.httpsProxy.trim();
  return {
    appearance: normalizeAppearance(settings.appearance),
    conversationStyle: normalizeConversationStylePreferences(settings.conversationStyle),
    individuation: normalizeIndividuation(settings.individuation),
    proxy: {
      mode: normalizeProxyMode(settings.proxy.mode),
      httpProxy,
      httpsProxy,
      noProxy:
        settings.proxy.noProxy.trim() || defaultAppSettings.proxy.noProxy,
    },
    browser: {
      privacyMode: settings.browser.privacyMode === true,
    },
    thinking: {
      visible: settings.thinking?.visible === true,
    },
    guidance: {
      deliveryMode:
        settings.guidance?.deliveryMode === 'immediate' ? 'immediate' : 'queue',
    },
    terminal: {
      runtime: normalizeTerminalRuntime(settings.terminal?.runtime),
    },
    managedModelConfigs: normalizeManagedModelConfigs(
      settings.managedModelConfigs,
    ),
    importedThemeStyle: normalizeImportedThemeStyle(settings.importedThemeStyle),
    companionEnabled: settings.companionEnabled !== false,
    companion: normalizeCompanionSettings(settings.companion),
    font: {
      family: settings.font.family.trim(),
      displayName: settings.font.displayName.trim(),
      filePath: settings.font.filePath.trim(),
    },
    user: {
      name: settings.user.name.trim() || defaultAppSettings.user.name,
      membership:
        settings.user.membership.trim() || defaultAppSettings.user.membership,
      avatarEmoji:
        settings.user.avatarEmoji.trim() || defaultAppSettings.user.avatarEmoji,
      avatarImagePath: settings.user.avatarImagePath?.trim() ?? '',
    },
  };
}

function proxyModeFromStorage(
  value: string | null,
  httpProxy: string,
  httpsProxy: string,
): AppSettingsState['proxy']['mode'] {
  if (value === 'system') {
    return 'system';
  }
  if (value === 'manual') {
    return httpProxy.trim() || httpsProxy.trim() ? 'manual' : 'none';
  }
  return value === 'none' ? 'none' : defaultAppSettings.proxy.mode;
}

function normalizeProxyMode(
  value: AppSettingsState['proxy']['mode'],
) {
  if (value === 'system') {
    return 'system';
  }
  if (value === 'manual') {
    return 'manual';
  }
  return 'none';
}

function terminalRuntimeFromStorage(value: string | null): TerminalRuntime {
  return normalizeTerminalRuntime(value as TerminalRuntime | undefined);
}

function normalizeTerminalRuntime(value?: TerminalRuntime): TerminalRuntime {
  return normalizeHostTerminalRuntime(value);
}

export function persistAppSettings(settings: AppSettingsState) {
  window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(normalizeAppearance(settings.appearance)));
  saveConversationStyle(settings.conversationStyle);
  saveIndividuation(settings.individuation);
  window.localStorage.setItem('cardbush_proxy_mode', settings.proxy.mode);
  window.localStorage.setItem('cardbush_proxy_http', settings.proxy.httpProxy);
  window.localStorage.setItem('cardbush_proxy_https', settings.proxy.httpsProxy);
  window.localStorage.setItem('cardbush_proxy_no_proxy', settings.proxy.noProxy);
  window.localStorage.setItem(
    'cardbush_browser_privacy_mode',
    String(settings.browser.privacyMode),
  );
  window.localStorage.removeItem('cardbush_shadow_accent_color');
  window.localStorage.setItem(
    'cardbush_thinking_visible',
    String(settings.thinking.visible),
  );
  window.localStorage.setItem(
    'cardbush_guidance_delivery_mode',
    settings.guidance.deliveryMode,
  );
  window.localStorage.removeItem('cardbush_thinking_accent_color');
  window.localStorage.setItem(
    'cardbush_terminal_runtime',
    normalizeTerminalRuntime(settings.terminal.runtime),
  );
  window.localStorage.setItem(
    'cardbush_managed_model_configs',
    JSON.stringify(settings.managedModelConfigs.map((config) => ({
      ...config,
      apiKey: '',
      hasApiKey: config.hasApiKey === true || Boolean(config.apiKey),
      apiKeyMasked: config.apiKeyMasked,
    }))),
  );
  window.localStorage.removeItem('cardbush_runtime_default_model_id');
  window.localStorage.removeItem('cardbush_background_image_path');
  if (settings.importedThemeStyle) {
    window.localStorage.setItem(
      importedThemeStyleStorageKey,
      JSON.stringify(settings.importedThemeStyle),
    );
  } else {
    window.localStorage.removeItem(importedThemeStyleStorageKey);
  }
  window.localStorage.setItem(
    'cardbush_cardling_enabled',
    String(settings.companionEnabled),
  );
  window.localStorage.setItem('cardbush_cardling_size', settings.companion.size);
  window.localStorage.setItem(
    'cardbush_cardling_opacity',
    String(settings.companion.opacity),
  );
  window.localStorage.setItem('cardbush_cardling_motion', settings.companion.motion);
  window.localStorage.setItem('cardbush_font_family', settings.font.family);
  window.localStorage.setItem(
    'cardbush_font_display_name',
    settings.font.displayName,
  );
  window.localStorage.setItem('cardbush_font_file_path', settings.font.filePath);
  window.localStorage.setItem('cardbush_user_name', settings.user.name);
  window.localStorage.setItem('cardbush_user_membership', settings.user.membership);
  window.localStorage.setItem('cardbush_user_avatar', settings.user.avatarEmoji);
  window.localStorage.setItem(
    'cardbush_user_avatar_image',
    settings.user.avatarImagePath ?? '',
  );
}

function readCompanionSettings(): CompanionSettings {
  return normalizeCompanionSettings({
    size: window.localStorage.getItem('cardbush_cardling_size') as CompanionSize,
    opacity: Number(window.localStorage.getItem('cardbush_cardling_opacity')),
    motion: window.localStorage.getItem('cardbush_cardling_motion') as CompanionMotionMode,
  });
}

function normalizeCompanionSettings(
  value?: Partial<CompanionSettings>,
): CompanionSettings {
  const size = normalizeCompanionSize(value?.size);
  const motion = normalizeCompanionMotion(value?.motion);
  const opacity = Number(value?.opacity);
  return {
    size,
    motion,
    opacity: Number.isFinite(opacity)
      ? Math.max(0.55, Math.min(1, Math.round(opacity * 100) / 100))
      : defaultAppSettings.companion.opacity,
  };
}

function normalizeCompanionSize(value?: string): CompanionSize {
  return value === 'compact' || value === 'large' || value === 'normal'
    ? value
    : defaultAppSettings.companion.size;
}

function normalizeCompanionMotion(value?: string): CompanionMotionMode {
  return value === 'full' || value === 'reduced' || value === 'off'
    ? value
    : defaultAppSettings.companion.motion;
}
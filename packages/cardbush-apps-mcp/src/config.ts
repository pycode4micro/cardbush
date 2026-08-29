import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface ComputerUsePluginConfig {
  screenshotDirectory: string;
  allowOpenApp: boolean;
  allowWindowClose: boolean;
}

export interface CardbushAppsRuntimeConfig {
  serviceEnabled: boolean;
  computerUse: {
    installed: boolean;
    enabled: boolean;
    config: ComputerUsePluginConfig;
  };
}

export function defaultAppsRuntimeConfig(): CardbushAppsRuntimeConfig {
  return {
    serviceEnabled: true,
    computerUse: {
      installed: true,
      enabled: true,
      config: {
        screenshotDirectory: '',
        allowOpenApp: true,
        allowWindowClose: true,
      },
    },
  };
}

export function readAppsRuntimeConfig(
  path = process.env.CARDBUSH_APPS_CONFIG_PATH?.trim(),
): CardbushAppsRuntimeConfig {
  if (!path) return defaultAppsRuntimeConfig();
  if (!isAbsolute(path)) throw new Error('CARDBUSH_APPS_CONFIG_PATH must be absolute.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (isMissing(error)) return defaultAppsRuntimeConfig();
    throw error;
  }
  const root = record(parsed, 'CardBush Apps configuration must be an object.');
  const plugins = Array.isArray(root.plugins) ? root.plugins : [];
  const plugin = plugins.find((item) => record(item).id === 'computer_use');
  if (!plugin) throw new Error('CardBush Apps configuration is missing computer_use.');
  const value = record(plugin);
  const config = record(value.config);
  const screenshotDirectory = string(config.screenshotDirectory);
  if (screenshotDirectory && !isAbsolute(screenshotDirectory)) {
    throw new Error('computer_use screenshotDirectory must be absolute.');
  }
  return {
    serviceEnabled: bool(root.serviceEnabled, 'serviceEnabled'),
    computerUse: {
      installed: bool(value.installed, 'computer_use.installed'),
      enabled: bool(value.enabled, 'computer_use.enabled'),
      config: {
        screenshotDirectory,
        allowOpenApp: bool(config.allowOpenApp, 'computer_use.allowOpenApp'),
        allowWindowClose: bool(config.allowWindowClose, 'computer_use.allowWindowClose'),
      },
    },
  };
}

function record(value: unknown, message = 'Expected an object.'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean.`);
  return value;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

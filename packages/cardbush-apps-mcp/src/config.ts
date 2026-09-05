import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface ComputerUsePluginConfig {
  screenshotDirectory: string;
  allowOpenApp: boolean;
  allowWindowClose: boolean;
  yieldToUser: boolean;
  restorePointer: boolean;
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
        yieldToUser: true,
        restorePointer: true,
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
  const plugin = plugins.find((item) => {
    const id = record(item).id;
    return id === 'computer-use' || id === 'computer_use';
  });
  if (!plugin) throw new Error('CardBush Apps configuration is missing computer-use.');
  const value = record(plugin);
  const config = record(value.config);
  const screenshotDirectory = string(config.screenshotDirectory);
  if (screenshotDirectory && !isAbsolute(screenshotDirectory)) {
    throw new Error('computer-use screenshotDirectory must be absolute.');
  }
  return {
    serviceEnabled: bool(root.serviceEnabled, 'serviceEnabled'),
    computerUse: {
      installed: bool(value.installed, 'computer-use.installed'),
      enabled: bool(value.enabled, 'computer-use.enabled'),
      config: {
        screenshotDirectory,
        allowOpenApp: bool(config.allowOpenApp, 'computer-use.allowOpenApp'),
        allowWindowClose: bool(config.allowWindowClose, 'computer-use.allowWindowClose'),
        yieldToUser: optionalBool(config.yieldToUser, true),
        restorePointer: optionalBool(config.restorePointer, true),
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

function optionalBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

import type { AppLanguage, ManagedModelConfig } from '../../types';
import { SettingsDropdown } from './SettingsDropdown';

export const customProviderValue = '__custom_provider__';
export const suggestedProviders = ['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'qwen'];

export function normalizeProvider(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

export function collectProviderOptions(configs: Pick<ManagedModelConfig, 'provider'>[]) {
  const providers = new Set(suggestedProviders);
  for (const config of configs) {
    const provider = normalizeProvider(config.provider);
    if (provider && provider !== customProviderValue) providers.add(provider);
  }
  return [...providers, customProviderValue];
}

export function ModelProviderSelect({ language, value, options, disabled, onChange }: {
  language: AppLanguage;
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const label = language === 'zh' ? '模型商' : 'Provider';
  return <label className="settings-field">
    <span>{label}</span>
    <SettingsDropdown label={label} value={value} disabled={disabled} onChange={onChange}
      options={options.map(provider => ({
        value: provider,
        label: provider === customProviderValue ? language === 'zh' ? '自定义服务商…' : 'Custom provider…' : provider,
      }))}/>
  </label>;
}

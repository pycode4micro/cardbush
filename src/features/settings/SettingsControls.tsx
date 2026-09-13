import type * as React from 'react';
import { Children, isValidElement } from 'react';
import { SettingsDropdown } from './SettingsDropdown';

export function SettingsSelect({ name, title, subtitle, value, onChange, children, icons }: {
  name: string; title: string; subtitle?: string; value: string;
  onChange: (value: string) => void; children: React.ReactNode;
  icons?: Record<string, React.ReactNode>;
}) {
  const options = Children.toArray(children).filter(isValidElement<{value: string; children: React.ReactNode; disabled?: boolean}>).map(option => ({
    value: option.props.value, label: option.props.children, disabled: option.props.disabled, icon: icons?.[option.props.value],
  }));
  return <div className="settings-select-row">
    <span><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
    <SettingsDropdown name={name} label={title} value={value} onChange={onChange} options={options} />
  </div>;
}

export function SettingsCard({
  title,
  subtitle,
  headerAction,
  bodyHidden = false,
  children,
}: {
  title: string;
  subtitle?: string;
  headerAction?: React.ReactNode;
  bodyHidden?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-card">
      <div className={`settings-card-header${headerAction ? ' has-action' : ''}`}>
        <div className="settings-card-heading">
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {headerAction && <div className="settings-card-header-action">{headerAction}</div>}
      </div>
      {!bodyHidden && <div className="settings-card-body">{children}</div>}
    </section>
  );
}

export function SettingsDivider() {
  return <div className="settings-divider" />;
}

export function SettingsGroupTitle({ children }: { children: React.ReactNode }) {
  return <div className="settings-group-title">{children}</div>;
}

export function SettingsRadio({
  className,
  name,
  title,
  subtitle,
  value,
  checked,
  onChange,
}: {
  className?: string;
  name: string;
  title: string;
  subtitle?: string;
  value: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className={`settings-radio${className ? ` ${className}` : ''}`}>
      <input name={name} type="radio" value={value} checked={checked} onChange={onChange} />
      <span>
        <strong>{title}</strong>
        {subtitle && <small>{subtitle}</small>}
      </span>
    </label>
  );
}

export function SettingsSwitch({
  title,
  subtitle,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`settings-switch${disabled ? ' disabled' : ''}`}>
      <span>
        <strong>{title}</strong>
        {subtitle && <small>{subtitle}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

export function SettingsInput({
  label,
  type = 'text',
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  type?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

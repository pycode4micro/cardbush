import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface SettingsDropdownOption {
  value: string;
  label: ReactNode;
  searchText?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export function SettingsDropdown({ id, name, label, describedBy, value, options, disabled, onChange, minMenuWidth = 218 }: {
  id?: string;
  name?: string;
  label: string;
  describedBy?: string;
  value: string;
  options: SettingsDropdownOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
  minMenuWidth?: number;
}) {
  const generatedId = useId();
  const menuId = `${id ?? generatedId}-options`;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex(option => option.value === value);
  const [activeIndex, setActiveIndex] = useState(Math.max(0, selectedIndex));
  const search = useRef({ text: '', time: 0 });
  const enabledIndices = options.flatMap((option, index) => option.disabled ? [] : [index]);

  const close = (restoreFocus = false) => {
    menu.current?.hidePopover();
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const show = (index = selectedIndex) => {
    setActiveIndex(index >= 0 && !options[index]?.disabled ? index : enabledIndices[0] ?? 0);
    setOpen(true);
  };
  const choose = (index: number) => {
    if (!options[index] || options[index].disabled) return;
    if (options[index].value !== value) onChange(options[index].value);
    close(true);
  };

  useLayoutEffect(() => {
    if (!open || disabled || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const gap = 6, margin = 12;
    const width = Math.min(Math.max(rect.width, minMenuWidth), window.innerWidth - margin * 2);
    const below = window.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    const upwards = below < Math.min(options.length * 34 + 12, 220) && above > below;
    const height = Math.min(336, Math.max(60, upwards ? above : below));
    Object.assign(menu.current.style, {
      left: `${Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin)}px`,
      top: `${upwards ? rect.top - gap : rect.bottom + gap}px`,
      width: `${width}px`, maxHeight: `${height}px`,
      translate: upwards ? '0 -100%' : 'none',
    });
    menu.current.showPopover();
  }, [open, disabled, options.length, minMenuWidth]);

  useEffect(() => {
    const node = menu.current;
    const sync = (event: Event) => { if ((event as ToggleEvent).newState === 'closed') setOpen(false); };
    node?.addEventListener('toggle', sync);
    return () => node?.removeEventListener('toggle', sync);
  }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close(); };
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);
    return () => { window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', dismiss, true); };
  }, [open]);
  useEffect(() => {
    if (disabled) close();
  }, [disabled]);
  useEffect(() => {
    const list = menu.current;
    const option = list?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (!open || !list || !option) return;
    // Scroll the menu itself; scrollIntoView can move the settings page too.
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop - 5;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight + 5;
    }
  }, [activeIndex, open]);

  return <div className="settings-dropdown">
    {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
    <button ref={trigger} id={id} value={value} type="button" className="settings-dropdown-trigger" role="combobox"
      aria-label={label} aria-describedby={describedBy} aria-controls={menuId} aria-expanded={open}
      aria-haspopup="listbox" aria-activedescendant={open ? `${menuId}-${activeIndex}` : undefined}
      disabled={disabled} onClick={() => open ? close() : show()}
      onKeyDown={event => {
        if (event.key === 'Tab') { if (open) close(); return; }
        if (event.key === 'Escape') { if (open) { event.preventDefault(); close(true); } return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          if (event.key === 'Home') return show(enabledIndices[0]);
          if (event.key === 'End') return show(enabledIndices.at(-1));
          if (!open) return show();
          const current = enabledIndices.indexOf(activeIndex);
          setActiveIndex(enabledIndices[(current + (event.key === 'ArrowDown' ? 1 : -1) + enabledIndices.length) % enabledIndices.length] ?? 0);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (open) choose(activeIndex); else show();
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const now = Date.now();
          search.current = { text: now - search.current.time < 700 ? search.current.text + event.key : event.key, time: now };
          const text = search.current.text.toLocaleLowerCase();
          const index = options.findIndex(option => !option.disabled && (option.searchText ?? String(option.label)).toLocaleLowerCase().startsWith(text));
          if (index >= 0) { event.preventDefault(); show(index); }
        }
      }}>
      {options[selectedIndex]?.icon}<span>{options[selectedIndex]?.label ?? value}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    <div ref={menu} id={menuId} popover="auto" className="settings-dropdown-popover" role="listbox" aria-label={label}>
      {options.map((option, index) => <button key={option.value} value={option.value} id={`${menuId}-${index}`} data-index={index}
        className={`settings-dropdown-option${index === activeIndex ? ' highlighted' : ''}`} type="button" role="option"
        aria-selected={value === option.value} disabled={option.disabled} tabIndex={-1}
        onPointerMove={() => !option.disabled && setActiveIndex(index)} onPointerDown={event => event.preventDefault()}
        onClick={() => choose(index)}>
        {option.icon}<span>{option.label}</span>{value === option.value && <Check size={14} aria-hidden="true" />}
      </button>)}
    </div>
  </div>;
}

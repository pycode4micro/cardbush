import { useState, type ToggleEvent } from 'react';

export function useDisclosureState(key: string, expanded?: Set<string>) {
  const [open, setOpen] = useState(() => expanded?.has(key) ?? false);
  const onToggle = (event: ToggleEvent<HTMLDetailsElement>) => {
    const value = event.currentTarget.open;
    setOpen(value);
    if (!expanded) return;
    if (value) {
      expanded.add(key);
      if (expanded.size > 80) expanded.delete(expanded.values().next().value!);
    } else expanded.delete(key);
  };
  return {open, onToggle};
}

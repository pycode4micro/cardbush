import { createContext, useContext } from 'react';

export const SettingsSectionTitle = createContext<string | null>(null);

/** A disclosure already labels its content. Standalone panels supply their own heading. */
export function usePanelHeading(title: string) {
  return useContext(SettingsSectionTitle) === title ? null : title;
}

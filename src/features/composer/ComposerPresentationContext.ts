import { createContext } from 'react';

// Placement and presentation are independent. Embedded workspaces can keep the
// saved standard/simple composer; content-cover inputs retain their minimal UI.
export const ComposerPresentationContext = createContext<{
  style?: 'standard' | 'simple';
  portalInputOnly?: boolean;
  preview?: boolean;
  preservePermissions?: boolean;
} | null>(null);

import { createContext } from 'react';

/** Reuse the active main composer's state and submission path in content-cover mode. */
export const ComposerPortalContext = createContext<HTMLElement | null>(null);

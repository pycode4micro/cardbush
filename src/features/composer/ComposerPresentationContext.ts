import { createContext } from 'react';

// Component previews/editors can override the saved presentation locally.
export const ComposerPresentationContext = createContext<{ style: 'standard' | 'simple'; preview?: boolean } | null>(null);

import { createContext } from 'react';

export const ComposerPresentationContext = createContext<{ style: 'standard' | 'simple'; preview?: boolean }>({ style: 'standard' });

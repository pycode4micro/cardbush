export const visualThemeTokens = [
  '--bg', '--surface', '--surface-strong', '--surface-raised', '--border',
  '--text', '--text-mid', '--text-soft', '--accent', '--accent-soft',
  '--info', '--success', '--warning', '--danger',
] as const;

export interface VisualThemeContext {
  theme: 'bright' | 'dark' | 'cyberpunk';
  preference: 'light' | 'dark' | 'cyberpunk' | 'system' | 'custom';
  colorScheme: 'light' | 'dark';
  background: string;
  fontFamily: string;
  tokens: Record<typeof visualThemeTokens[number], string>;
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { visualThemeTokens, type VisualThemeContext } from './visualThemeContextSchema';

/** A small, atomic, read-only-to-the-agent snapshot; no settings or secrets. */
export class VisualThemeContextStore {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  write(input: VisualThemeContext): Promise<void> {
    if (!input || !['bright', 'dark', 'cyberpunk'].includes(input.theme)
      || !['light', 'dark', 'cyberpunk', 'system', 'custom'].includes(input.preference)
      || !['light', 'dark'].includes(input.colorScheme)) throw new Error('Invalid visual theme context.');
    const value = (raw: unknown) => {
      if (typeof raw !== 'string' || !raw.trim() || raw.length > 512 || /[{}\u0000]/.test(raw)) throw new Error('Invalid visual theme value.');
      return raw.trim();
    };
    const context = {
      version: 1, updatedAt: new Date().toISOString(),
      theme: input.theme, preference: input.preference, colorScheme: input.colorScheme,
      background: value(input.background), fontFamily: value(input.fontFamily),
      tokens: Object.fromEntries(visualThemeTokens.map(token => [token, value(input.tokens?.[token])])),
    };
    const serialized = JSON.stringify(context, null, 2) + '\n';
    const task = this.pending.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath + '.tmp', serialized, 'utf8');
      await fs.rename(this.filePath + '.tmp', this.filePath);
    });
    this.pending = task;
    return task;
  }
}

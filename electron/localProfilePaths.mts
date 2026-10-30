import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Profile configuration is shared; CLI conversations remain separate. */
export function localDesktopProfile(env = process.env, home = homedir(), platform = process.platform) {
  if (env.CARDBUSH_CLI_PROFILE_DIR) return resolve(env.CARDBUSH_CLI_PROFILE_DIR);
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'cardbush');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'cardbush');
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(xdg, 'cardbush');
}

export const localCliDataRoot = () => resolve(process.env.CARDBUSH_CLI_DATA_DIR ?? join(homedir(), '.cardbush', 'cli-agent'));

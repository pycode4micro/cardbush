import { defaultTerminalRuntime, normalizeTerminalRuntime } from '@cardbush/platform/contracts';

/** Desktop supplies the OS; browser previews can still choose a sensible default. */
export function hostPlatform(): string {
  return globalThis.window?.cardbushDesktop?.platform ?? (globalThis.navigator?.platform?.startsWith('Win') ? 'win32' : 'linux');
}
export const defaultHostTerminalRuntime = () => defaultTerminalRuntime(hostPlatform());
export const normalizeHostTerminalRuntime = (value: unknown) => normalizeTerminalRuntime(value, hostPlatform());

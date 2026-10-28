// Windows 10 1809 is the shared desktop/Store baseline; newer Windows 10
// releases and Windows 11 both report kernel major version 10.
export const minimumWindowsVersion = '10.0.17763.0';

export function windowsReleaseSupported(release: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(release);
  if (!match) return false;
  const version = match.slice(1).map(Number);
  if (!version.every(Number.isSafeInteger)) return false;
  const minimum = minimumWindowsVersion.split('.').slice(0, 3).map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

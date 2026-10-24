/** Windows workers expose case-sensitive env objects even though the host OS
 * treats names case-insensitively. Keep aliases consistent across that boundary. */
export function normalizeHostEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== 'win32') return { ...env };
  const values = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(env)) values.set(name.toUpperCase(), value);
  const result: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(env)) result[name] = values.get(name.toUpperCase());
  for (const [name, value] of values) result[name] = value;
  return result;
}

export function hostEnvironmentValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[name] ?? (process.platform === 'win32'
    ? Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1] : undefined);
}

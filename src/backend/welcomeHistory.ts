import { createDesktopRuntimeSession } from '../runtime-client/ElectronRuntimeSession';

export async function fetchWelcomeHistory(signal: AbortSignal) {
  const runtime = createDesktopRuntimeSession();
  const now = Date.now();
  try {
    return await runtime.client.listUserPrompts({
      since: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
      until: new Date(now).toISOString(), limit: 1200,
    }, signal);
  } finally {
    runtime.dispose();
  }
}

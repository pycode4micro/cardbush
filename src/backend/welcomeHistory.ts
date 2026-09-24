import { createDesktopRuntimeSession } from '../runtime-client/ElectronRuntimeSession';

export function welcomeHistoryRequest() {
  const now = Date.now();
  return { since: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(), until: new Date(now).toISOString(), limit: 1200 };
}

export async function fetchWelcomeHistory(signal: AbortSignal) {
  const runtime = createDesktopRuntimeSession();
  try {
    return await runtime.client.listUserPrompts(welcomeHistoryRequest(), signal);
  } finally {
    runtime.dispose();
  }
}

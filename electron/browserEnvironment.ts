import type { BrowserConnectorStatus } from './browserConnectorBroker';
/** Safe projection of an existing broker snapshot. No connection, pairing or tab actions. */
export function browserConnectionEnvironment(status?: BrowserConnectorStatus) {
  return { running: status?.bridgeRunning ?? false,
    connections: (status?.connections ?? []).map(({ id, browser, connected }) => ({ id, browser, connected })),
    websiteAuthorization: 'connection', tabIsolation: 'session' };
}

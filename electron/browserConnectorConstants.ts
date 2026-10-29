export const browserConnectorExtensionId = 'iibaamkfgackofhhpadgnmgcjkhckeln';
export const browserConnectorExtensionOrigin =
  `chrome-extension://${browserConnectorExtensionId}/`;
export const browserConnectorNativeHostName = 'com.cardbush.browser_connector';
export const browserConnectorProtocol = 'cardbush.chrome_connector.v1';
export const browserConnectorConfigDirectoryName = 'browser-connector';
export const browserConnectorConfigFileName = 'bridge.json';

// Shared with the extension transport (covered by the pairing regression).
// Stay below Windows' default dynamic client range and spread candidates so a
// single excluded port range cannot exhaust them. Never reserve OS ports.
export const browserConnectorDiscoveryPorts = Object.freeze(Array.from({ length: 32 }, (_, index) => 43120 + index * 137));

export const chromeConnectorExtensionId = 'iibaamkfgackofhhpadgnmgcjkhckeln';
export const chromeConnectorExtensionOrigin =
  `chrome-extension://${chromeConnectorExtensionId}/`;
export const chromeConnectorNativeHostName = 'com.cardbush.browser_connector';
export const chromeConnectorProtocol = 'cardbush.chrome_connector.v1';
export const chromeConnectorConfigDirectoryName = 'browser-connector';
export const chromeConnectorConfigFileName = 'bridge.json';

// Shared with the extension transport (covered by the pairing regression).
// Stay below Windows' default dynamic client range and spread candidates so a
// single excluded port range cannot exhaust them. Never reserve OS ports.
export const chromeConnectorDiscoveryPorts = Object.freeze(Array.from({ length: 32 }, (_, index) => 43120 + index * 137));

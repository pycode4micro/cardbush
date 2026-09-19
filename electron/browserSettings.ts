import { app } from 'electron';
import { join } from 'node:path';

export const browserConfigurationPath = () => join(app.getPath('userData'), 'product-host', 'config', 'browser.json');
export async function browserConfigurationStore() {
  const { BrowserConfigStore } = await import('@cardbush/product-host');
  return new BrowserConfigStore(browserConfigurationPath());
}

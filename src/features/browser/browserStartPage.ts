import { defaultBrowserConfiguration } from '@cardbush/bush-protocol';
import type { InspectorOpenDetail } from '../inspector/inspectorEvents';

export async function newBrowserTab(): Promise<InspectorOpenDetail> {
  const configuration = await window.cardbushDesktop?.readBrowserConfiguration?.() ?? defaultBrowserConfiguration();
  return { target: configuration.startPage, newTab: true };
}

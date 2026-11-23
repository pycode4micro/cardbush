import { useUiLanguage } from '../../src/i18n/react';
import { DeferredModuleNotice } from '../../src/shared/recoverableLazy';

export function WebModuleNotice({ retry }: { retry(): void }) {
  return <DeferredModuleNotice language={useUiLanguage()} retry={retry}/>;
}

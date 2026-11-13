import { ExternalLink } from 'lucide-react';
import { uiText } from '../../i18n';
import { useUiLanguage } from '../../i18n/react';

export function ComponentEmbedBar({targets, missing, configure, open}: {
  targets: Map<string, string>; missing: string[]; configure: () => void; open: (url: string) => void;
}) {
  const t = uiText(useUiLanguage());
  if (!missing.length && !targets.size) return null;
  return <div className="component-embed-bar">
    {missing.length > 0 && <button type="button" data-embed-settings onClick={configure}>{t('homeComponents.reviewEmbeds')}</button>}
    {[...targets].map(([origin,url]) => <button key={origin} type="button" data-embed-open
      aria-label={t('homeLayout.openWebsite',{name:new URL(origin).host})} onClick={() => open(url)}>
      <ExternalLink aria-hidden="true"/>{new URL(origin).host}
    </button>)}
  </div>;
}

import { ExternalLink } from 'lucide-react';
import { uiText } from '../../i18n';
import { useUiLanguage } from '../../i18n/react';

export function ComponentEmbedBar({targets, missing, configure, open, showWebsite}: {
  targets: Map<string, string>; missing: string[]; configure: () => void; open: (url: string) => void; showWebsite?: (url:string)=>void;
}) {
  const t = uiText(useUiLanguage());
  if (!missing.length && !targets.size) return null;
  return <div className="component-embed-bar">
    {missing.length > 0 && <button type="button" data-embed-settings onClick={configure}>{t('homeComponents.reviewEmbeds')}</button>}
    {[...targets].map(([origin,url]) => {
      const name = new URL(origin).host;
      return <span className="component-embed-target" key={origin}>
        {showWebsite && <button type="button" data-embed-website onClick={() => showWebsite(url)}>{t('homeComponents.viewWebsiteHere',{name})}</button>}
        <button type="button" data-embed-open title={t('homeLayout.openWebsite',{name})}
          aria-label={t('homeLayout.openWebsite',{name})} onClick={() => open(url)}>
          <ExternalLink aria-hidden="true"/>{!showWebsite && name}</button>
      </span>;
    })}
  </div>;
}

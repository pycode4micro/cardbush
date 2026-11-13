import { uiText, type MessageKey } from '../../i18n';
import { useUiLanguage } from '../../i18n/react';

export function ComponentOriginGrants({legendKey, sites, approved, change}: {
  legendKey:MessageKey; sites:string[]; approved:string[]; change:(value:string[])=>void;
}) {
  const t = uiText(useUiLanguage());
  if (!sites.length) return null;
  return <fieldset><legend>{t(legendKey)}</legend>{sites.map(site =>
    <label key={site} className="component-action-grant"><input type="checkbox" value={site} checked={approved.includes(site)}
      onChange={event => change(event.target.checked ? [...approved,site] : approved.filter(value => value !== site))}/><span>{site}</span></label>)}</fieldset>;
}

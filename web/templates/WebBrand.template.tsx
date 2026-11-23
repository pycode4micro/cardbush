import { uiText } from '../../src/i18n';
import { useUiLanguage } from '../../src/i18n/react';

export function Brand({ small = false }: { small?: boolean }) {
  const language = useUiLanguage();
 return <div className={`brand ${small ? 'small' : ''}`}><span className="brand-symbol">{uiText(language)("web.brandSymbol")}</span><span>{uiText(language)("web.brandName")}<span className="brand-subtitle">{uiText(language)("web.brandCompany")}</span></span></div>; }

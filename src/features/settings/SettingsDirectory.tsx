import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Database, MonitorCog, Network, Search, Settings, SlidersHorizontal, X } from 'lucide-react';
import { usePageEntrance } from '../navigation/usePageEntrance';
import { uiText, type MessageKey } from '../../i18n';
import type { AppLanguage } from '../../types';
import { settingsDescriptions, settingsDestination, settingsLabels, settingsNavigationGroups, settingsSectionLabel, settingsSectionMatchesQuery,
  type SettingsCategory, type SettingsCategoryId, type SettingsPage, type VisibleSettingsSection } from './settingsNavigation';
import './settingsDirectory.css';
import { SettingsSectionTitle } from './settingsHeading';

const icons = { preferences: Settings, personal: SlidersHorizontal, connections: Network, tools: MonitorCog, data: Database };
type Props = {
  language: AppLanguage; page: SettingsPage; active: boolean; version: string;
  navigate(page: SettingsPage): void;
  renderSection(section: VisibleSettingsSection, visible: boolean): ReactNode;
};

export function SettingsDirectory({ language, page, active, version, navigate, renderSection }: Props) {
  const t = uiText(language);
  const { category, section } = settingsDestination(page);
  const [query, setQuery] = useState('');
  const scroll = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<SettingsPage, number>());
  const [expandedSections, setExpandedSections] = useState<Partial<Record<SettingsPage, VisibleSettingsSection | null>>>({});
  const expanded = expandedSections[page];
  const lastChoice = useRef<SettingsPage | null>(null);
  const lastPage = useRef<SettingsPage | null>(null);
  const choose = (next: SettingsPage) => { lastChoice.current = next; navigate(next); };
  useLayoutEffect(() => {
    if (!active) return;
    const previous = lastPage.current;
    lastPage.current = page;
    const scroller = scroll.current;
    if (!scroller) return;
    const target = page === 'overview' && previous && lastChoice.current
      ? scroller.querySelector<HTMLButtonElement>('[data-settings-target="' + lastChoice.current + '"]') : null;
    (target ?? heading.current)?.focus({ preventScroll: true });
    scroller.scrollTop = positions.current.get(page) ?? 0;
    if (section && !positions.current.has(page)) {
      const group = scroller.querySelector<HTMLElement>('[data-settings-section="' + section + '"]');
      if (group && group.getBoundingClientRect().bottom > scroller.getBoundingClientRect().bottom) group.scrollIntoView({block: 'start'});
    }
  }, [page, active, section]);
  usePageEntrance(track, page, active);
  return <section className="settings-content" ref={scroll} onScroll={event => { if (active) positions.current.set(page, event.currentTarget.scrollTop); }}
    aria-label={t('common.settings')}>
    <div className="settings-track" ref={track}>
      <header className="settings-page-header">
        <h1 ref={heading} tabIndex={-1}>{category
          ? <><button type="button" data-settings-overview onClick={() => navigate('overview')}>{t('common.settings')}</button>
            <ChevronRight aria-hidden="true"/><span>{t(category.label)}</span></>
          : t('common.settings')}</h1>
        {!category && <label className="settings-search"><Search aria-hidden="true"/>
          <input type="search" aria-label={t('settingsView.searchSettings')} placeholder={t('settingsView.searchSettings_5d017d7')}
            value={query} onChange={event => { setQuery(event.target.value); positions.current.delete('overview'); }}
            onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }}/>
          {query && <button type="button" aria-label={t('settingsView.clearSearch')} onClick={() => setQuery('')}><X/></button>}
        </label>}
      </header>
      {category ? <CategoryPanel key={page} category={category} initial={section ?? (expanded === undefined ? category.sections[0] : expanded)}
        onExpand={value => { if (!section) setExpandedSections(prior => ({ ...prior, [page]: value })); }}
        language={language} active={active} renderSection={renderSection}/>
        : <Overview language={language} query={query} choose={choose} version={version}/>}
    </div>
  </section>;
}

function Overview({language, query, choose, version}: {language: AppLanguage; query: string; choose(page: SettingsPage): void; version: string}) {
  const t = uiText(language), terms = query.trim().toLocaleLowerCase();
  const rows = settingsNavigationGroups.flatMap(category => {
    const entries: { target: SettingsPage; label: MessageKey; description: MessageKey; icon: SettingsCategoryId }[] = [];
    if (!terms || t(category.label).toLocaleLowerCase().includes(terms)) {
      entries.push({ target: category.id, label: category.label, description: category.description, icon: category.id });
    } else {
      for (const item of category.sections.filter(id => settingsSectionMatchesQuery(id, terms))) {
        entries.push({ target: item, label: settingsSectionLabel(item), description: settingsDescriptions[item], icon: category.id });
      }
    }
    return entries;
  });
  return <>
    <nav className="settings-directory" aria-label={t('settingsView.settingsSections')}>
      {rows.map(row => {
        const Icon = icons[row.icon];
        return <button key={row.target} type="button" data-settings-target={row.target} onClick={() => choose(row.target)}>
          <Icon aria-hidden="true"/><span><strong>{t(row.label)}</strong><small>{t(row.description)}</small></span><ChevronRight aria-hidden="true"/>
        </button>;
      })}
      {!rows.length && <p className="settings-search-empty" role="status">{t('settingsView.noMatchingSettings')}</p>}
    </nav>
    {!terms && <footer className="settings-about"><h2>{t('settingsDirectory.about')}</h2>
      <p>{t('settingsDirectory.version', {version})}</p>
      <button type="button" data-settings-target="diagnostics" onClick={() => choose('diagnostics')}>{t(settingsLabels.diagnostics)}</button>
    </footer>}
  </>;
}

function CategoryPanel({ category, initial, onExpand, language, active, renderSection }: {
  category: SettingsCategory; initial: VisibleSettingsSection | null; onExpand(value: VisibleSettingsSection | null): void; language: AppLanguage;
  active: boolean; renderSection: Props['renderSection'];
}) {
  const [expanded, setExpanded] = useState<VisibleSettingsSection | null>(initial);
  return <div className="settings-category">{category.sections.map(id => <Disclosure key={id} id={id}
    open={id === expanded} toggle={() => { const next = expanded === id ? null : id; setExpanded(next); onExpand(next); }} language={language} active={active} renderSection={renderSection}/>)}</div>;
}

function Disclosure({ id, open, toggle, language, active, renderSection }: {
  id: VisibleSettingsSection; open: boolean; toggle(): void; language: AppLanguage; active: boolean; renderSection: Props['renderSection'];
}) {
  const [visited, setVisited] = useState(open);
  const panelId = useId(), t = uiText(language);
  const title = t(settingsSectionLabel(id));
  return <section className="settings-category-section">
    <h2><button type="button" id={panelId + '-label'} data-settings-section={id} aria-expanded={open} aria-controls={panelId}
      onClick={() => { toggle(); setVisited(true); }}>
      <span><strong>{title}</strong><small>{t(settingsDescriptions[id])}</small></span><ChevronDown aria-hidden="true"/>
    </button></h2>
    <div className="category-settings-body" id={panelId} role="region" aria-labelledby={panelId + '-label'} hidden={!open}>
      {visited && <SettingsSectionTitle.Provider value={title}>{renderSection(id, active && open)}</SettingsSectionTitle.Provider>}
    </div>
  </section>;
}

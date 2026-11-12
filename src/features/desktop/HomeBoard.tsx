import { useEffect, useState } from 'react';
import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';
import { ComponentEditor, componentError } from '../components/ComponentEditor';
import { componentId } from '../components/componentId';
import type { HtmlComponent } from '../components/componentModel';
import { saveComponents, useComponents } from '../components/componentStore';
import { HomeBoardView, type NativeHomeContent } from './HomeBoardView';
import { HomeWebsiteDialog, type WebsiteBlock } from './HomeWebsiteDialog';
import { blockKey, homeLayoutKey, moveHomeBlock, readHomeLayout, reconcileHomeLayout, type HomeBlock, type NativeSection } from './homeLayout';

export function HomeBoard({language, native, visible, editing, onDone, onCreate}: {
  language: AppLanguage; native: NativeHomeContent; visible: boolean; editing: boolean; onDone(): void; onCreate?(draft: string): void;
}) {
  const t = uiText(language), library = useComponents();
  const [saved, setSaved] = useState(readHomeLayout);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState('');
  const [website, setWebsite] = useState<{initial?: WebsiteBlock}>();
  const [editor, setEditor] = useState<{initial?: HtmlComponent; revision: number}>();
  useEffect(() => {
    const reload = (event: StorageEvent) => {
      if (!event.key || event.key === homeLayoutKey) setSaved(readHomeLayout());
    };
    window.addEventListener('storage', reload);
    return () => window.removeEventListener('storage', reload);
  }, []);
  const blocks = reconcileHomeLayout(saved, library.items).filter(block => {
    if (block.kind === 'native') return !block.hidden;
    return block.kind !== 'html' || library.items.some(item => item.id === block.id && item.home);
  });
  function change(update: (current: HomeBlock[]) => HomeBlock[]) {
    try {
      const next = update(reconcileHomeLayout(readHomeLayout(), library.items));
      localStorage.setItem(homeLayoutKey, JSON.stringify({version:1, blocks:next}));
      setSaved(next); setError(''); return true;
    } catch { setError(t('homeLayout.saveFailed')); return false; }
  }
  function toggleHtml(item: HtmlComponent) {
    void saveComponents({...library, items: library.items.map(old => old.id === item.id ? {...old, home:!old.home} : old)}, library.revision)
      .then(() => setError(''), cause => setError(componentError(language, cause)));
  }
  function remove(block: HomeBlock) {
    if (block.kind === 'html') {
      const item = library.items.find(item => item.id === block.id);
      if (item?.home) toggleHtml(item);
    } else if (block.kind === 'native') toggleNative(block.id);
    else change(current => current.filter(old => blockKey(old) !== blockKey(block)));
  }
  function toggleNative(id: NativeSection) {
    change(current => current.some(block => block.kind === 'native' && block.id === id)
      ? current.map(block => block.kind === 'native' && block.id === id ? {...block, hidden:!block.hidden} : block)
      : [...current, {kind:'native', id}]);
  }
  return <>
    <HomeBoardView language={language} native={native} blocks={blocks} library={library.items} visible={visible}
      editing={editing} picker={picker} error={error} onDone={() => { setPicker(false); onDone(); }}
      togglePicker={() => setPicker(open => !open)} toggleHtml={toggleHtml} toggleNative={toggleNative}
      createInChat={onCreate && (() => onCreate(t('homeComponents.createDraft')))}
      editHtml={initial => setEditor({initial, revision:library.revision})} editWeb={initial => setWebsite({initial})}
      openWeb={url => {
        const host = window.cardbushDesktop;
        if (host?.openExternal) void host.openExternal(url).catch(() => setError(t('homeLayout.openFailed')));
        else window.open(url, '_blank', 'noopener,noreferrer');
      }}
      remove={remove} move={(source, target) => change(current => moveHomeBlock(current, source, target))}
      resize={(block, dimension, value) => change(current => current.map(old => blockKey(old) === blockKey(block) ? {...old, [dimension]:value} : old))}/>
    {editor && <ComponentEditor language={language} initial={editor.initial} onClose={() => setEditor(undefined)} onSave={async item => {
      const items = editor.initial ? library.items.map(old => old.id === item.id ? item : old)
        : [...library.items, {...item, home:true, order:Math.max(-1,...library.items.map(old => old.order))+1}];
      await saveComponents({...library, items}, editor.revision);
      setError(''); setEditor(undefined); setPicker(false);
    }}/>}
    {website && <HomeWebsiteDialog language={language} initial={website.initial} onClose={() => setWebsite(undefined)} onSave={(title, url) => {
      const initial = website.initial;
      const ok = change(current => initial ? current.map(block => block.kind === 'web' && block.id === initial.id ? {...block, title, url} : block)
        : [...current, {kind:'web', id:componentId(), title, url}]);
      if (ok) { setWebsite(undefined); setPicker(false); }
    }}/>}
  </>;
}

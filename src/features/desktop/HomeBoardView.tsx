import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, Code2, ExternalLink, Globe, GripVertical, MessageSquare, Minus, Pencil, Plus } from 'lucide-react';
import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';
import { HtmlComponentSurface } from '../components/HtmlComponentSurface';
import { HomeWebsiteView } from '../components/HomeWebsiteView';
import type { HtmlComponent } from '../components/componentModel';
import { blockKey, nativeSections, type HomeBlock, type HomeDimensions, type NativeSection } from './homeLayout';
import { HomeBlockResizeHandles } from './HomeBlockResizeHandles';
import './homeBoard.css';

export type NativeHomeContent = Record<NativeSection, {title: string; content: ReactNode}>;
type ViewProps = {
  language: AppLanguage; blocks: HomeBlock[]; native: NativeHomeContent; library: HtmlComponent[];
  editing: boolean; picker: boolean; visible: boolean; error: string;
  onDone(): void; togglePicker(): void; toggleNative(id: NativeSection): void; toggleHtml(item: HtmlComponent): void;
  createInChat?(): void; editHtml(item?: HtmlComponent): void; editWeb(item?: Extract<HomeBlock, {kind:'web'}>): void;
  openWeb(url: string): void; remove(block: HomeBlock): void; move(source: string, target: string): void;
  resize(block: HomeBlock, dimensions: HomeDimensions): void;
};

function NearViewport({children}: {children: ReactNode}) {
  const host = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (entered) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setEntered(true);
    }, {rootMargin:'300px'});
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, [entered]);
  return <div className="home-live-surface" ref={host}>{entered && children}</div>;
}

function HomeWebsiteBlock({url, title}: {url:string; title:string}) {
  if (window.cardbushDesktop?.homeComponentLibrary) return <HomeWebsiteView url={url}/>;
  return <iframe name="cardbush-home-website" title={title} src={url} sandbox="allow-scripts" {...{credentialless:''}} referrerPolicy="no-referrer"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'; fullscreen 'none'"/>;
}

export function HomeBoardView(p: ViewProps) {
  const t = uiText(p.language), dragged = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const endDrag = () => { dragged.current = null; setOver(null); };
  return <>
    <header className="home-board-heading"><h1>{t(p.editing ? 'homeLayout.edit' : 'desktop.home')}</h1>
      {p.editing && <div className="home-board-actions">
        <button type="button" data-home-action="add" aria-expanded={p.picker} onClick={p.togglePicker}><Plus/>{t('homeComponents.add')}</button>
        <button type="button" data-home-action="done" onClick={p.onDone}><Check/>{t('homeLayout.done')}</button>
      </div>}
    </header>
    {p.picker && p.editing && <section className="home-board-picker" aria-label={t('homeComponents.add')}>
      <div className="home-board-options">
        <button type="button" data-home-add="web" onClick={() => p.editWeb()}><Globe/>{t('homeLayout.website')}</button>
        <button type="button" data-home-add="html" onClick={() => p.editHtml()}><Code2/>{t('homeLayout.html')}</button>
        {p.createInChat && <button type="button" data-home-add="chat" onClick={p.createInChat}><MessageSquare/>{t('homeComponents.createInChat')}</button>}
      </div>
      <div className="home-board-options" role="group" aria-label={t('homeLayout.native')}>
        {nativeSections.map(id => {
          const selected = p.blocks.some(block => block.kind === 'native' && block.id === id);
          return <button type="button" key={id} data-home-native={id} aria-pressed={selected} onClick={() => p.toggleNative(id)}>{selected ? <Check/> : <Plus/>}{p.native[id].title}</button>;
        })}
      </div>
      {p.library.length > 0 && <div className="home-board-options" role="group" aria-label={t('appCenterModel.components')}>
        {p.library.map(item => <button type="button" key={item.id} data-home-html={item.id} aria-pressed={!!item.home} onClick={() => p.toggleHtml(item)}>
          {item.home ? <Check/> : <Plus/>}{item.title}</button>)}
      </div>}
    </section>}
    {p.error && <p className="home-board-error" role="alert">{p.error}</p>}
    <div className="home-board" data-editing={p.editing}>
      {p.blocks.map((block, index) => {
        const key = blockKey(block);
        const html = block.kind === 'html' ? p.library.find(item => item.id === block.id) : undefined;
        const name = block.kind === 'web' ? block.title : block.kind === 'native' ? p.native[block.id].title : html!.title;
        const width = block.width ?? html?.width ?? (block.kind === 'native' ? 12 : 6);
        const height = block.height ?? html?.height ?? (block.kind === 'web' ? 320 : undefined);
        const column = block.column && Math.min(block.column, 13 - width);
        const heights = [...new Set([160, 240, 320, 480, 640, 960, ...(height ? [height] : [])])].sort((a,b) => a-b);
        return <section key={key} aria-label={name} data-home-block={key} data-kind={block.kind}
          data-drop-target={over === key || undefined} className="home-block"
          style={{'--block-span':width, '--block-height':height && height + 'px', '--block-column':column} as CSSProperties}
          onDragOver={event => { if (p.editing && dragged.current && dragged.current !== key) { event.preventDefault(); setOver(key); } }}
          onDrop={event => { if (p.editing && dragged.current) { event.preventDefault(); p.move(dragged.current, key); endDrag(); } }}>
          {p.editing && <div className="home-block-move" draggable aria-hidden="true"
            onDragStart={event => {
              const card = event.currentTarget.parentElement!;
              const bounds = card.getBoundingClientRect();
              dragged.current = key;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', name);
              event.dataTransfer.setDragImage(card, event.clientX - bounds.left, event.clientY - bounds.top);
            }} onDragEnd={endDrag}/>}
          {p.editing && <div className="home-block-tools" role="group" aria-label={t('homeComponents.edit', {name})}>
            <span className="home-drag" title={t('homeLayout.drag')} aria-hidden="true"><GripVertical/></span>
            <button type="button" data-home-action="earlier" aria-label={t('common.moveUp')} disabled={!index}
              onClick={() => p.move(key, blockKey(p.blocks[index - 1]))}><ArrowUp/></button>
            <button type="button" data-home-action="later" aria-label={t('common.moveDown')} disabled={index === p.blocks.length - 1}
              onClick={() => p.move(key, blockKey(p.blocks[index + 1]))}><ArrowDown/></button>
            <label>{t('homeLayout.width')}<select value={width} onChange={event => p.resize(block, {width:Number(event.target.value)})}>
              {Array.from({length:10}, (_, i) => i+3).map(value => <option key={value} value={value}>{t('homeLayout.columns', {count:value})}</option>)}</select></label>
            <label>{t('homeLayout.height')}<select value={height ?? ''} onChange={event => p.resize(block, {height:Number(event.target.value) || undefined})}>
              {block.kind === 'native' && <option value="">{t('homeLayout.auto')}</option>}
              {heights.map(value => <option key={value} value={value}>{t('homeLayout.pixels', {count:value})}</option>)}</select></label>
            {width < 12 && <label>{t('homeLayout.column')}<select name="column" value={column ?? ''} onChange={event => p.resize(block, {column:Number(event.target.value) || undefined})}>
              <option value="">{t('homeLayout.auto')}</option>
              {Array.from({length:13-width}, (_, i) => i+1).map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
            {block.kind !== 'native' && <button type="button" data-home-action="configure" aria-label={t('homeComponents.edit', {name})}
              onClick={() => block.kind === 'web' ? p.editWeb(block) : p.editHtml(html)}><Pencil/></button>}
            <button type="button" data-home-action="remove" aria-label={t('homeComponents.unpin', {name})} onClick={() => p.remove(block)}><Minus/></button>
          </div>}
          <div className="home-block-body" inert={p.editing}>
            {block.kind === 'native' ? p.native[block.id].content : <>
              <header className="home-block-title"><h2>{name}</h2>
                {block.kind === 'web' && <button type="button" aria-label={t('homeLayout.openWebsite', {name})} onClick={() => p.openWeb(block.url)}><ExternalLink/></button>}</header>
              {p.editing ? <div className="home-block-preview">{block.kind === 'web' ? <><Globe/>{new URL(block.url).host}</> : <Code2/>}</div>
                : p.visible && <NearViewport>{block.kind === 'web' ?
                  <HomeWebsiteBlock key={block.url} url={block.url} title={name}/>
                  : <HtmlComponentSurface component={html!} onHome/>}</NearViewport>}
            </>}
          </div>
          {p.editing && <HomeBlockResizeHandles width={width} column={column} height={height}
            label={t('canvasStage.resizeItem')} onCommit={dimensions => p.resize(block, dimensions)}/>}
        </section>;
      })}
    </div>
  </>;
}

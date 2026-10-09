import { useEffect, useState } from 'react';
import { FilePlus2, FolderOpen, RefreshCw, Save } from 'lucide-react';
import { MdPresentation } from './MdPresentation';
import { useMarkdownFile } from './useMarkdownFile';
import { writeMarkdownGraph } from './markdownGraph';

const draftKey = 'cardbush.md-presentation.draft';
function initialSource() {
  try { const draft = localStorage.getItem(draftKey); if (draft) return draft; } catch { /* Storage can be disabled. */ }
  return writeMarkdownGraph({ attributes: { name: 'md演示' }, introduction: '用 Markdown 记录内容，用节点链接组织思路。', nodes: [
    { id: 'start', attributes: { name: '从这里开始', position: { x: 100, y: 240 } }, body: '点击节点即可编辑内容。\n\n支持 **Markdown**、列表与代码。' },
    { id: 'ideas', attributes: { name: '连接想法', position: { x: 430, y: 100 } }, body: '使用 [[#start]] 引用另一个节点。也可以通过节点两侧的圆点连线。' },
    { id: 'write', attributes: { name: '编辑与保存', position: { x: 430, y: 370 } }, body: '在图谱与 Markdown 之间切换。保存为 .md 文件后，可在外部编辑，再重新载入。\n\n[[#start]]' },
  ] });
}
export function MdPresentationApp({ language }: { language: 'zh' | 'en' }) {
  const [source, setSource] = useState(initialSource), [storageError, setStorageError] = useState('');
  const [pending, setPending] = useState<() => void>();
  const files = useMarkdownFile(), t = (cn: string, en: string) => language === 'zh' ? cn : en;
  useEffect(() => { try { localStorage.setItem(draftKey, source); setStorageError(''); } catch { setStorageError(t('草稿无法自动保存，请保存为 .md 文件。', 'Draft could not be stored. Save it to a .md file.')); } }, [source]);
  const replace = (operation: () => void) => { if (source.trim() && source !== files.file?.text) setPending(() => operation); else operation(); };
  const open = async (reload = false) => { const result = await (reload ? files.reload() : files.open()); if (result) { files.accept(result); setSource(result.text); } };
  return <div className="md-app"><header className="md-app-header"><div><strong>md演示</strong><small title={files.file?.path}>{files.file?.path || t('本地草稿 · Markdown 与图谱同步', 'Local draft · Markdown and graph in sync')}{files.file && files.file.text !== source ? t(' · 未保存', ' · Unsaved') : ''}</small></div>
    <button type="button" disabled={files.busy} onClick={() => replace(() => { files.clear(); setSource(writeMarkdownGraph({ attributes: { name: t('新文档', 'New document') }, introduction: '', nodes: [] })); })}><FilePlus2 size={15}/>{t('新建', 'New')}</button>
    <button type="button" disabled={files.busy} onClick={() => replace(() => void open())}><FolderOpen size={15}/>{t('打开 .md', 'Open .md')}</button>
    {files.file && <button type="button" disabled={files.busy} onClick={() => replace(() => void open(true))} title={t('读取外部编辑后的文件', 'Read changes from disk')}><RefreshCw size={15}/>{t('重新载入', 'Reload')}</button>}
    <button type="button" disabled={files.busy} onClick={() => void files.save(source, 'md-presentation')}><Save size={15}/>{t('保存 .md', 'Save .md')}</button>
    {files.file && <button type="button" disabled={files.busy} onClick={() => void files.save(source, 'md-presentation', true)}>{t('另存为', 'Save as')}</button>}
  </header>{pending && <div className="md-replace-notice" role="alert"><span>{t('当前内容尚未保存到文件。继续替换？', 'Current edits have not been saved to a file. Replace them?')}</span><button type="button" onClick={() => { const operation = pending; setPending(undefined); operation(); }}>{t('放弃并继续', 'Discard and continue')}</button><button type="button" onClick={() => setPending(undefined)}>{t('保留编辑', 'Keep editing')}</button></div>}{(files.error || storageError) && <p role="alert" className="md-error">{files.error || storageError}</p>}<MdPresentation source={source} onChange={setSource} language={language}/></div>;
}

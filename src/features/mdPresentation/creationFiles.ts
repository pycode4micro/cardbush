import type { MarkdownFile, MarkdownFileRequest } from '../../../electron/mdPresentationFiles';
import { createBushItPage, getBushItPages, selectBushItPage, updateBushItPage, type BushItPage } from './bushItPageStore';

export const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
export const parentDirectory = (path: string) => path.replace(/[\\/][^\\/]+$/, '');
export const sameFile = (a: string, b: string) => /^[a-z]:/i.test(a) ? a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase() : a === b;
export function linkedMarkdownPath(currentPath: string, href: string) {
  return linkedMarkdownTarget(currentPath, href)?.path;
}
export function linkedMarkdownTarget(currentPath: string, href: string): { path: string; fragment?: string } | undefined {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return undefined;
  try {
    const base = currentPath.replaceAll('\\', '/');
    const target = new URL(href, `file://${base.startsWith('/') ? '' : '/'}${base.split('/').map(part => encodeURIComponent(part)).join('/')}`);
    const path = decodeURIComponent(target.pathname);
    if (!/\.(md|markdown)$/i.test(path)) return undefined;
    if (path.includes('\0')) return undefined;
    return { path: /^[a-z]:/i.test(currentPath) ? path.replace(/^\/(?=[a-z]:)/i, '') : path,
      ...(target.hash || href.endsWith('#') ? { fragment: target.hash || '#' } : {}) };
  } catch { return undefined; }
}
export async function markdownFile(input: MarkdownFileRequest) {
  if (!window.cardbushDesktop?.markdownFile) throw Error('Markdown 文件服务不可用，请重启更新后的应用。');
  return window.cardbushDesktop.markdownFile(input);
}
export function acceptCreationFile(file: MarkdownFile, projectDir = '') {
  const existing = getBushItPages().pages.find(page => !page.archived && page.file && sameFile(page.file.path, file.path));
  if (!existing) return createBushItPage(file.text, file, projectDir);
  if (projectDir && existing.projectDir !== projectDir) updateBushItPage(existing.id, { projectDir });
  reconcileCreationFile(existing.id, file); selectBushItPage(existing.id); return existing.id;
}
/** Never replace a manual draft with an Agent/external editor's changes. */
export function reconcileCreationFile(id: string, file: MarkdownFile) {
  const page = getBushItPages().pages.find(page => page.id === id);
  if (!page?.file || !sameFile(page.file.path, file.path)) return;
  if (page.unloaded) { updateBushItPage(id, { source: file.text, file, unloaded: false, externalFile: undefined }); return; }
  if (page.file.revision === file.revision) {
    if (page.externalFile) updateBushItPage(id, { externalFile: undefined });
    return;
  }
  if (page.source === page.file.text || page.source === file.text) updateBushItPage(id, { source: file.text, file, externalFile: undefined });
  else if (page.externalFile?.revision !== file.revision) updateBushItPage(id, { externalFile: file });
}
export async function refreshCreationFile(id: string) {
  const page = getBushItPages().pages.find(page => page.id === id);
  if (!page?.file) return;
  const file = await markdownFile({ action: 'reload', path: page.file.path, rootPath: page.projectDir || parentDirectory(page.file.path) });
  // An in-flight disk read may finish after a newer save. Do not roll that save back.
  const latest = getBushItPages().pages.find(page => page.id === id);
  if (file && latest?.file?.revision === page.file.revision) reconcileCreationFile(id, file);
}
const saves = new Map<string, Promise<MarkdownFile | undefined>>();
export function saveCreationFile(id: string): Promise<MarkdownFile | undefined> {
  const task = (saves.get(id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const page = getBushItPages().pages.find(page => page.id === id);
    if (page?.unloaded) throw Error('文档正在加载，请稍后再保存。');
    if (!page?.file || page.source === page.file.text && !page.externalFile) return page?.file;
    if (page.externalFile) throw Error('文件已被 Agent 或其他编辑器修改，请先处理版本冲突。');
    try {
      const file = await markdownFile({ action: 'save', path: page.file.path, rootPath: page.projectDir || parentDirectory(page.file.path), revision: page.file.revision, text: page.source });
      const latest = getBushItPages().pages.find(item => item.id === id);
      // Save As may finish while an autosave to the old backing file is still pending.
      if (file && latest?.file && sameFile(latest.file.path, page.file.path) && latest.file.revision === page.file.revision) updateBushItPage(id, { file, externalFile: undefined });
      return file ?? undefined;
    } catch (error) { await refreshCreationFile(id).catch(() => {}); throw error; }
  });
  saves.set(id, task);
  void task.finally(() => { if (saves.get(id) === task) saves.delete(id); }).catch(() => {});
  return task;
}
export function creationFileRoot(page: BushItPage) { return page.projectDir || (page.file ? parentDirectory(page.file.path) : ''); }

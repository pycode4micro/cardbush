import { useCallback, useEffect, useState } from 'react';
import { Check, LoaderCircle, RefreshCw } from 'lucide-react';
import { readGlobalInstructions, saveGlobalInstructions, type GlobalInstructionsSnapshot } from '../../backend/globalInstructions';
import type { AppLanguage } from '../../types';

export type InstructionsSource = { read: typeof readGlobalInstructions; save: typeof saveGlobalInstructions };
const localSource: InstructionsSource = { read: readGlobalInstructions, save: saveGlobalInstructions };
export function GlobalInstructionsPanel({ language, source = localSource }: { language: AppLanguage; source?: InstructionsSource }) {
  const zh = language === 'zh';
  const [snapshot, setSnapshot] = useState<GlobalInstructionsSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    source.read().then(value => {
      if (active) { setSnapshot(value); setDraft(value.content); }
    }).catch(caught => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [source]);

  const reload = useCallback(async () => {
    if (snapshot && draft !== snapshot.content && !window.confirm(zh ? '重新读取会覆盖尚未保存的编辑，继续吗？' : 'Reloading will replace your unsaved edits. Continue?')) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const value = await source.read();
      setSnapshot(value); setDraft(value.content);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }, [draft, snapshot, zh, source]);

  const save = async () => {
    if (!snapshot || busy) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const value = await source.save(draft, snapshot.revision);
      setSnapshot(value); setDraft(value.content); setSaved(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  return <section className="settings-card global-instructions-card">
    <div className="settings-card-header">
      <div className="settings-card-heading">
        <h3 id="global-instructions-title">{zh ? '全局约束' : 'Global instructions'}</h3>
        <p>{zh ? '所有会话与子任务共用的长期偏好，保存后从下一轮生效。' : 'Shared preferences for conversations and subtasks. Saved changes apply from the next turn.'}</p>
      </div>
    </div>
    <div className="settings-card-body">
      <textarea
        id="global-agent-instructions"
        aria-labelledby="global-instructions-title"
        className="global-instructions-editor"
        value={draft}
        disabled={busy || !snapshot}
        spellCheck={false}
        onChange={event => { setDraft(event.currentTarget.value); setSaved(false); }}
        placeholder={zh ? '例如：回答语言、工作偏好、交付要求。支持 Markdown。' : 'For example: preferred language, working style, and delivery requirements. Markdown is supported.'}
      />
      <details className="global-instructions-file-details">
        <summary>{zh ? '文件位置与项目规则' : 'File location & project rules'}</summary>
        <p className="global-instructions-hint">{zh ? '项目及目录级规则可自行写入对应的 AGENTS.md。当前工作目录及其上级目录的规则会自动加载；更深子目录的规则按需读取。' : 'Maintain project and directory rules in their own AGENTS.md files. Rules from the working directory and its ancestors load automatically; deeper directory rules are read when needed.'}</p>
        {snapshot && <code className="global-instructions-path" title={snapshot.path}>{snapshot.path}</code>}
      </details>
      <div className="global-instructions-actions">
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void reload()}><RefreshCw size={14} />{zh ? '重新读取' : 'Reload file'}</button>
        <button className="primary-button" type="button" disabled={busy || !snapshot || draft === snapshot.content} onClick={() => void save()}>
          {busy ? <LoaderCircle size={14} /> : <Check size={14} />}{zh ? '保存' : 'Save'}
        </button>
      </div>
      {error && <p className="global-instructions-error" role="alert">{error}</p>}
      {saved && <p className="global-instructions-hint" role="status">{zh ? '已保存到 AGENTS.md' : 'Saved to AGENTS.md'}</p>}
    </div>
  </section>;
}

import { dialogEventHandler } from '../../shared/dialogEvents';
import { Settings2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppLanguage } from '../../types';
import { normalizeComposerFlow, type ComposerFlow } from './componentModel';

export function ComposerLayoutSettings({ language, flow, onChange }: {
  language: AppLanguage; flow?: ComposerFlow; onChange: (flow: ComposerFlow) => void;
}) {
  const [open, setOpen] = useState(false), zh = language === 'zh';
  return <>
    <button type="button" className="composer-layout-settings-button" aria-label={zh ? '输入框与会话布局' : 'Composer and conversation layout'}
      onClick={() => setOpen(true)}><Settings2 size={14}/></button>
    {open && <FlowDialog language={language} flow={normalizeComposerFlow(flow)} onChange={onChange} onClose={() => setOpen(false)}/>}
  </>;
}

function FlowDialog({ language, flow, onChange, onClose }: {
  language: AppLanguage; flow: ComposerFlow; onChange: (flow: ComposerFlow) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), zh = language === 'zh';
  useEffect(() => { dialog.current?.showModal(); const element = dialog.current; return () => element?.close(); }, []);
  return <dialog ref={dialog} className="composer-layout-dialog" aria-label={zh ? '输入框与会话布局' : 'Composer and conversation layout'}
    onPointerDown={event => event.stopPropagation()} onClose={dialogEventHandler(event => { if (!event.currentTarget.open) onClose(); })}>
    <header><strong>{zh ? '输入框与会话布局' : 'Composer and conversation layout'}</strong>
      <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={onClose}><X size={16}/></button></header>
    <label>{zh ? '发送后的输入框位置' : 'Composer position after sending'}
      <select value={flow.afterSend} onChange={event => onChange({ ...flow, afterSend: event.target.value as ComposerFlow['afterSend'] })}>
        <option value="bottom">{zh ? '自动移到底部' : 'Move to bottom'}</option>
        <option value="keep">{zh ? '保持当前位置' : 'Keep current position'}</option>
      </select></label>
    <label>{zh ? '会话输出开始位置' : 'Conversation output starts'}
      <select value={flow.output} onChange={event => onChange({ ...flow, output: event.target.value as ComposerFlow['output'] })}>
        <option value="above">{zh ? '输入框上方' : 'Above the composer'}</option>
        <option value="below">{zh ? '输入框下方' : 'Below the composer'}</option>
      </select></label>
    <p>{flow.output === 'below'
      ? zh ? '内容向下堆积，滚动时输入框吸附在顶部，并留出间距。' : 'Content grows downward. Scrolling pins the composer near the top with a little space.'
      : flow.afterSend === 'keep'
        ? zh ? '内容从上方开始向下延伸，遇到输入框时让出位置，继续在下方显示。' : 'Content starts above and continues below, leaving room for the composer.'
        : zh ? '发送后使用底部输入框，内容在上方显示。' : 'After sending, the composer sits at the bottom with content above.'}</p>
    <p>{zh ? '输入框始终水平居中，发送前后保持同宽。编排时可上下移动、调整宽度；自动移到底部时，靠近落点会吸附，避免小幅移动。'
      : 'The composer stays centered and keeps its width after sending. Move it vertically or resize its width in the editor. Bottom mode snaps nearby positions to the landing point to avoid small shifts.'}</p>
    <button type="button" className="composer-layout-done" onClick={onClose}>{zh ? '完成' : 'Done'}</button>
  </dialog>;
}

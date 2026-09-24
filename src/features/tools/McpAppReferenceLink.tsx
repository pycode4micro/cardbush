import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PanelsTopLeft } from 'lucide-react';
import { parseMcpAppReference } from '@cardbush/bush-protocol';
import type { AppLanguage } from '../../types';
import { McpAppPanel } from './McpAppPanel';
import './mcp-app.css';

export const McpAppReferencesContext = createContext<{ sessionId: string; enabled: boolean } | null>(null);

/** Only assistant-authored links open an App; a link itself performs no I/O. */
export function McpAppReferenceLink({ reference, children, language }: { reference: string; children?: ReactNode; language: AppLanguage }) {
  const scope = useContext(McpAppReferencesContext);
  const identity = parseMcpAppReference(reference);
  const enabled = Boolean(scope?.enabled && identity?.sessionId === scope.sessionId);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { setOpen(false); }, [reference, scope?.sessionId, enabled]);
  const label = children || (language === 'zh' ? '打开 App' : 'Open App');
  const close = () => { setOpen(false); button.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={button} className="message-app-reference" type="button" disabled={!enabled} aria-haspopup="dialog"
      onClick={() => setOpen(true)} title={!enabled ? (language === 'zh' ? '本轮结束后可打开有效的 App 引用' : 'Valid App references can be opened after this turn') : undefined}>
      <PanelsTopLeft size={14} aria-hidden="true" /><span>{label}</span>
    </button>
    {enabled && open && identity && createPortal(<McpAppPanel key={reference} {...identity} language={language} autoOpen presentation="modal" onClose={close} />,
      button.current?.closest('.app') ?? document.body)}
  </>;
}

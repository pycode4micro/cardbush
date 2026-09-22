import { useContext, useEffect, useState } from 'react';
import { ConversationHostContext } from './conversationHost';
import { fileUrl } from '../shared/localPaths';

/** Preview components share rendering; only the byte source is host-specific. */
export function useConversationFileSource(path: string, enabled = true): { source: string; error?: string } {
  const host = useContext(ConversationHostContext);
  const external = /^(?:https?:|data:|blob:)/i.test(path.trim());
  const remote = Boolean(enabled && path && host?.readFile && !external);
  const key = `${host?.id ?? ''}:${path}`;
  const [file, setFile] = useState<{ key: string; source: string; error?: string }>();
  useEffect(() => {
    if (!remote || !host?.readFile) return;
    let alive = true, source = '';
    void host.readFile(path).then(({ blob }) => {
      if (!alive) return;
      source = URL.createObjectURL(blob); setFile({ key, source });
    }).catch(error => { if (alive) setFile({ key, source: '', error: String(error.message ?? error) }); });
    return () => { alive = false; if (source) URL.revokeObjectURL(source); };
  }, [host?.readFile, path, remote, key]);
  return !enabled ? { source: '' } : remote ? file?.key === key ? file : { source: '' } : { source: external ? path : fileUrl(path) };
}

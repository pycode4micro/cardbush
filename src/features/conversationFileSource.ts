import { useContext, useEffect, useState } from 'react';
import { ConversationHostContext } from './conversationHost';
import { fileUrl } from '../shared/localPaths';

/** Preview components share rendering; only the byte source is host-specific. */
export function useConversationFileSource(path: string, enabled = true, options: { preview?: boolean; revision?: string | number } = {}): { source: string; error?: string } {
  const host = useContext(ConversationHostContext);
  const external = /^(?:https?:|data:|blob:)/i.test(path.trim());
  const remote = Boolean(host && !external);
  const { preview, revision } = options;
  const key = JSON.stringify([host?.id, path, revision, preview]);
  const [file, setFile] = useState<{ key: string; source: string; error?: string }>();
  useEffect(() => {
    if (!remote || !enabled || !path) return;
    let alive = true, dispose: (() => void) | undefined;
    setFile(undefined);
    const load = async () => {
      if (preview) {
        if (!host?.previewFile) throw Error('Remote preview is unavailable. Update and restart CardBush.');
        return host.previewFile(path);
      }
      if (!host?.readFile) throw Error('Remote file reading is unavailable.');
      const { blob } = await host.readFile(path);
      const source = URL.createObjectURL(blob);
      return { source, dispose: () => URL.revokeObjectURL(source) };
    };
    void load().then(result => {
      if (!alive) { result.dispose(); return; }
      dispose = result.dispose; setFile({ key, source: result.source });
    }).catch(error => { if (alive) setFile({ key, source: '', error: String(error.message ?? error) }); });
    return () => { alive = false; dispose?.(); };
  }, [host?.readFile, host?.previewFile, path, remote, enabled, preview, key]);
  return !enabled ? { source: '' } : remote ? file?.key === key ? file : { source: '' } : { source: external ? path : fileUrl(path) };
}

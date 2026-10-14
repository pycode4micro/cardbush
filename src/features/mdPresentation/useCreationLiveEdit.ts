import { useEffect, useRef, useState } from 'react';
import { watchFileEditEvents } from '../../backend/fileEditEvents';
import { refreshCreationFile } from './creationFiles';
import type { BushItPage } from './bushItPageStore';
import { previewFileEdit, type FileEditPreview } from './fileEditPreview';

export type LiveDocumentEdit = FileEditPreview & { id: string; base: string; state: 'streaming' | 'ready' };

export function useCreationLiveEdit(page: BushItPage, sessionId: string | undefined, root: string) {
  const [preview, setPreview] = useState<LiveDocumentEdit>();
  const current = useRef(page); current.current = page;
  const composing = useRef(false);
  const cancel = useRef(() => {});
  useEffect(() => {
    setPreview(undefined);
    if (!sessionId || !page.file) return;
    const started = Date.now(), sequences = new Map<string, number>();
    const calls = new Map<string, { input: string; base: string; toolId?: string; turnId: string; blocked: boolean; displayed: boolean }>();
    let alive = true;
    cancel.current = () => { calls.forEach(call => { call.blocked = true; call.input = ''; call.base = ''; }); setPreview(undefined); };
    const unwatch = watchFileEditEvents(event => {
      if (event.sessionId !== sessionId || Date.parse(event.createdAt) < started) return;
      if ('sequence' in event) {
        if (event.sequence <= (sequences.get(event.turnId) ?? -1)) return;
        sequences.set(event.turnId, event.sequence);
        if (sequences.size > 32) sequences.delete(sequences.keys().next().value!);
      }
      if (event.kind === 'file_edit_preview') {
        const data = event.payload, existing = calls.get(data.previewId);
        // Replayed/duplicate/gapped fragments must never animate old edits.
        if (!existing && (data.offset !== 0 || calls.size >= 64)) return;
        const call = existing ?? { input: '', base: current.current.source, turnId: event.turnId, blocked: false, displayed: false };
        calls.set(data.previewId, call); call.toolId = data.toolCallId || call.toolId;
        if (data.state === 'discarded') { calls.delete(data.previewId); setPreview(value => value?.id === data.previewId ? undefined : value); return; }
        if (data.offset < call.input.length) return;
        if (data.offset !== call.input.length || call.input.length + data.delta.length > 2 * 1024 * 1024) call.blocked = true;
        const latest = current.current;
        if (composing.current) call.blocked = true;
        if (!call.displayed && latest.source === latest.file?.text) call.base = latest.source;
        if (latest.source !== call.base || latest.externalFile || latest.source !== latest.file?.text || latest.unloaded) call.blocked = true;
        if (call.blocked) { call.input = ''; call.base = ''; setPreview(value => value?.id === data.previewId ? undefined : value); return; }
        call.input += data.delta;
        const next = previewFileEdit(data.toolName, call.input, call.base, latest.file!.path, root);
        if (next && next.source !== call.base) { call.displayed = true; setPreview({ ...next, id: data.previewId, base: call.base, state: data.state }); }
        else setPreview(value => value?.id === data.previewId ? undefined : value);
      } else if (event.kind === 'turn_terminal' || event.kind === 'file_edit_preview_reset' || event.kind === 'tool_returned' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled') {
        const ended = event.kind === 'turn_terminal' || event.kind === 'file_edit_preview_reset';
        const ids = [...calls].filter(([, call]) => ended ? call.turnId === event.turnId : call.toolId === event.payload.toolCallId).map(([id]) => id);
        ids.forEach(id => { calls.delete(id); });
        const clear = () => { if (alive) setPreview(value => value && ids.includes(value.id) ? undefined : value); };
        if (event.kind === 'tool_returned' && !event.payload.resultError || ended) {
          // Only the real file may update the durable editor state. This also
          // handles shell-based edits, which have no structured input preview.
          void refreshCreationFile(page.id).finally(clear).catch(() => {});
        } else clear();
        if (ended) calls.clear();
      }
    });
    return () => { alive = false; unwatch(); cancel.current = () => {}; };
  }, [page.id, page.file?.path, sessionId, root]);
  // A user edit, Save As, or an external revision immediately takes precedence.
  const visible = preview && preview.base === page.source && !page.externalFile ? preview : undefined;
  return { preview: visible, beforeEdit: () => cancel.current(), compositionChange: (active: boolean) => { composing.current = active; } };
}

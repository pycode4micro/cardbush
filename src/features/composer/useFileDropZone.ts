import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CONVERSATION_DRAG_TYPE } from '../chat/ConversationExtraction';

function hasFiles(transfer: DataTransfer) {
  return transfer.files.length > 0 || transfer.types.includes('Files');
}

export function useFileDropZone(targetRef: RefObject<HTMLElement | null>, onDrop: (transfer: DataTransfer) => void) {
  const handlerRef = useRef(onDrop);
  const [active, setActive] = useState(false);
  useLayoutEffect(() => { handlerRef.current = onDrop; });

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let depth = 0;
    const reset = () => { depth = 0; setActive(false); };
    const accepts = (event: DragEvent) => event.dataTransfer &&
      (hasFiles(event.dataTransfer) || event.dataTransfer.types.includes('application/x-cardbush-quickload') || event.dataTransfer.types.includes(CONVERSATION_DRAG_TYPE));
    const enter = (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      depth += 1;
      setActive(true);
    };
    const over = (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = 'copy';
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget instanceof Node && !target.contains(event.relatedTarget)) { reset(); return; }
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const drop = (event: DragEvent) => {
      reset();
      if (!accepts(event)) return;
      event.preventDefault();
      event.stopPropagation();
      // Read the transfer synchronously: the browser clears its files after this event.
      handlerRef.current(event.dataTransfer!);
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') reset(); };
    target.addEventListener('dragenter', enter);
    target.addEventListener('dragover', over);
    target.addEventListener('dragleave', leave);
    target.addEventListener('drop', drop);
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    window.addEventListener('blur', reset);
    window.addEventListener('keydown', keydown);
    return () => {
      target.removeEventListener('dragenter', enter);
      target.removeEventListener('dragover', over);
      target.removeEventListener('dragleave', leave);
      target.removeEventListener('drop', drop);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
      window.removeEventListener('blur', reset);
      window.removeEventListener('keydown', keydown);
    };
  }, [targetRef]);
  return active;
}

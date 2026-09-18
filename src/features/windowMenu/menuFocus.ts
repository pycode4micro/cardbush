/** Restore the original editor and selection after navigating menu buttons. */
export function captureMenuFocus() {
  const element = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textControl = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
  const selection = textControl && textControl.selectionStart !== null
    ? { start: textControl.selectionStart, end: textControl.selectionEnd, direction: textControl.selectionDirection } : null;
  const ranges = Array.from({ length: window.getSelection()?.rangeCount ?? 0 }, (_, index) => window.getSelection()!.getRangeAt(index).cloneRange());
  return () => {
    if (!element?.isConnected) return;
    element.focus({ preventScroll: true });
    if (selection) textControl?.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
    else if (ranges.every(range => range.startContainer.isConnected && range.endContainer.isConnected)) {
      const current = window.getSelection();
      current?.removeAllRanges();
      for (const range of ranges) current?.addRange(range);
    }
  };
}

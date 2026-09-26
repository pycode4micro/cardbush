type InteractionHandlers = {
  pointerMove(event: PointerEvent): void;
  pointerDown(event: PointerEvent): void;
  keyboard(event: KeyboardEvent): void;
  focus(event: FocusEvent): void;
  reset(): void;
};

/** Window activation restores DOM focus/hover without expressing user intent. */
export function observeExplicitInteraction(handlers: InteractionHandlers): () => void {
  let keyboard = false, suspended = false;
  let pointer: { x: number; y: number } | undefined;
  const ready = () => !suspended && !document.hidden && document.hasFocus();
  const reset = () => { keyboard = false; handlers.reset(); };
  const blur = () => { suspended = true; reset(); };
  const resume = () => { suspended = false; reset(); };
  const visibility = () => { if (document.hidden) blur(); else resume(); };
  const pointerMove = (event: PointerEvent) => {
    const moved = event.movementX !== 0 || event.movementY !== 0
      || Boolean(pointer && (pointer.x !== event.clientX || pointer.y !== event.clientY));
    pointer = { x: event.clientX, y: event.clientY };
    if (ready() && event.pointerType !== 'touch' && moved) handlers.pointerMove(event);
  };
  const pointerDown = (event: PointerEvent) => { keyboard = false; handlers.pointerDown(event); };
  const keydown = (event: KeyboardEvent) => {
    // In particular, Alt+Tab and modifier release must not reveal restored focus.
    if (!ready() || event.isComposing || event.altKey || event.metaKey
      || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
    keyboard = true; handlers.keyboard(event);
  };
  const focus = (event: FocusEvent) => { if (ready() && keyboard) handlers.focus(event); };
  document.addEventListener('pointermove', pointerMove, true);
  document.addEventListener('pointerdown', pointerDown, true);
  window.addEventListener('keydown', keydown, true);
  document.addEventListener('focusin', focus, true);
  window.addEventListener('blur', blur);
  window.addEventListener('focus', resume);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    document.removeEventListener('pointermove', pointerMove, true);
    document.removeEventListener('pointerdown', pointerDown, true);
    window.removeEventListener('keydown', keydown, true);
    document.removeEventListener('focusin', focus, true);
    window.removeEventListener('blur', blur);
    window.removeEventListener('focus', resume);
    document.removeEventListener('visibilitychange', visibility);
  };
}

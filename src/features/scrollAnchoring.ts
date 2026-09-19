const suspensions = new WeakMap<HTMLElement, { original: string; owners: number }>();

/** Motion and disclosure updates may overlap and finish in either order. */
export function suspendScrollAnchoring(scroller: HTMLElement): () => void {
  let state = suspensions.get(scroller);
  if (!state) {
    state = { original: scroller.style.overflowAnchor, owners: 0 };
    suspensions.set(scroller, state);
    scroller.style.overflowAnchor = 'none';
  }
  state.owners += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.owners -= 1;
    if (state.owners === 0) {
      scroller.style.overflowAnchor = state.original;
      suspensions.delete(scroller);
    }
  };
}

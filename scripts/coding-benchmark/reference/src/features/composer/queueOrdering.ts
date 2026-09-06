export function reorderScopedQueue<T>(
  items: T[],
  sourceId: string,
  targetId: string,
  idOf: (item: T) => string,
  scopeOf: (item: T) => string,
): T[] {
  if (!sourceId || !targetId || sourceId === targetId) {
    return items;
  }
  const source = items.find((item) => idOf(item) === sourceId);
  const target = items.find((item) => idOf(item) === targetId);
  if (!source || !target || scopeOf(source) !== scopeOf(target)) {
    return items;
  }

  const scope = scopeOf(source);
  const scopedItems = items.filter((item) => scopeOf(item) === scope);
  const sourceIndex = scopedItems.findIndex((item) => idOf(item) === sourceId);
  const targetIndex = scopedItems.findIndex((item) => idOf(item) === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return items;
  }

  const reorderedScope = [...scopedItems];
  const [moved] = reorderedScope.splice(sourceIndex, 1);
  reorderedScope.splice(targetIndex, 0, moved);
  let scopedIndex = 0;
  return items.map((item) =>
    scopeOf(item) === scope ? reorderedScope[scopedIndex++] : item,
  );
}

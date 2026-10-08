export function splitAtOrderPanel<T>(
  items: readonly T[],
  panelIndex: number | null,
): { readonly before: readonly T[]; readonly after: readonly T[] } {
  const index = panelIndex === null
    ? items.length
    : Math.max(0, Math.min(panelIndex, items.length));

  return {
    before: items.slice(0, index),
    after: items.slice(index),
  };
}

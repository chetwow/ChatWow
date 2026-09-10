/** Resolve navigation without changing the committed selection. */
export function dropdownNavigationIndex(key: string, current: number, count: number): number {
  if (count === 0) return 0;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return (current + (key === "ArrowDown" ? 1 : -1) + count) % count;
}

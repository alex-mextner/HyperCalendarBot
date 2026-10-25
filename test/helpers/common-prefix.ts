/** Number of leading characters two strings share. Bounded by the shorter one, so identical inputs terminate. */
export function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index++;
  return index;
}

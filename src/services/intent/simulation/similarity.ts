// Near-duplicate check between committed synthetic fixtures and the private corpus (run locally
// only, see test/services/intent/simulation/fixture-privacy.test.ts). Distance is Levenshtein over
// normalized text divided by the longer length: 0 is equal after normalization, 1 is unrelated.

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]!;
}

export function normalizedEditDistance(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 0 : levenshtein(left, right) / longest;
}

/**
 * Fixture/source pairs closer than `threshold`. A length gap alone already rules most pairs out;
 * strings with no letters or digits carry no content and are never compared.
 */
export function nearDuplicates(
  fixtures: string[],
  sources: string[],
  threshold: number,
): { fixture: string; source: string }[] {
  const near: { fixture: string; source: string }[] = [];
  const measured = sources
    .map((source) => ({ source, length: normalize(source).length }))
    .filter((entry) => entry.length > 0);
  for (const fixture of fixtures) {
    const length = normalize(fixture).length;
    if (length === 0) continue;
    for (const { source, length: other } of measured) {
      const longest = Math.max(length, other);
      if (longest > 0 && Math.abs(length - other) / longest >= threshold) continue;
      if (normalizedEditDistance(fixture, source) < threshold) near.push({ fixture, source });
    }
  }
  return near;
}

/** Russian phonetic normalization: canonicalize voiced/voiceless pairs, remove soft/hard signs. */
export function phoneticNormalize(word: string): string {
  let s = word.toLowerCase();
  s = s.replace(/ё/g, 'е');
  s = s.replace(/[ъь]/g, '');
  s = s.replace(/б/g, 'п');
  s = s.replace(/в/g, 'ф');
  s = s.replace(/г/g, 'к');
  s = s.replace(/д/g, 'т');
  s = s.replace(/ж/g, 'ш');
  s = s.replace(/з/g, 'с');
  s = s.replace(/(.)\1+/g, '$1');
  return s;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

/** Max Levenshtein distance allowed for a given normalized word length. */
export function maxEditDistance(len: number): number {
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  return 2;
}

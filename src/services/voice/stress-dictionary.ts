// src/services/voice/stress-dictionary.ts
import { z } from 'zod';
import { voiceLogger } from './types';

/**
 * In-memory stress dictionary for Russian words.
 * Format: bare lowercase word -> stressed form with + before stressed vowel.
 * Example: "молоко" -> "молок+о"
 */
export class StressDictionary {
  private dict: Map<string, string>;
  private sortedKeys: string[];

  constructor(data: Record<string, string>) {
    this.dict = new Map(Object.entries(data));
    this.sortedKeys = [...this.dict.keys()].sort();
    voiceLogger.info({ size: this.dict.size }, 'Stress dictionary loaded');
  }

  lookup(word: string): string | null {
    return this.dict.get(word.toLowerCase()) ?? null;
  }

  lookupMany(words: string[]): Record<string, { stressed: string | null; similar: string[] }> {
    const result: Record<string, { stressed: string | null; similar: string[] }> = {};
    for (const w of words) {
      const stressed = this.lookup(w);
      const similar = stressed ? [] : this.findSimilar(w.toLowerCase(), 5);
      result[w] = { stressed, similar };
    }
    return result;
  }

  /**
   * Find similar words by trying progressively shorter prefixes.
   * Uses binary search on sorted keys for O(log n) prefix lookup.
   */
  findSimilar(word: string, limit: number): string[] {
    const results: string[] = [];
    const minPrefix = Math.max(3, Math.ceil(word.length * 0.6));

    for (let len = word.length - 1; len >= minPrefix && results.length < limit; len--) {
      const prefix = word.slice(0, len);
      const startIdx = this.bsearchFirst(prefix);

      for (let i = startIdx; i < this.sortedKeys.length && results.length < limit; i++) {
        const key = this.sortedKeys[i]!;
        if (!key.startsWith(prefix)) break;
        if (key !== word) {
          const stressed = this.dict.get(key)!;
          results.push(`${key} → ${stressed}`);
        }
      }
    }

    return results;
  }

  private bsearchFirst(prefix: string): number {
    let lo = 0;
    let hi = this.sortedKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sortedKeys[mid]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  get size(): number {
    return this.dict.size;
  }

  static async loadFromFile(path: string): Promise<StressDictionary> {
    const file = Bun.file(path);
    const data = z.record(z.string(), z.string()).parse(await file.json());
    return new StressDictionary(data);
  }
}

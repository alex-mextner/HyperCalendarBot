// src/services/voice/stress-dictionary.ts
import { z } from 'zod';
import { voiceLogger } from './types';

/**
 * In-memory stress dictionary for Russian words.
 * Format: bare lowercase word -> stressed form with + before stressed vowel.
 * Example: "молоко" -> "молок+о"
 *
 * The production file holds 555K entries: loading it costs about 80 MB of retained heap and over 300 MB at
 * the peak, on a container that shares a swapping 1 GiB budget. `lazyFromFile` therefore reads it on the
 * first `ensureLoaded()`, so a process that never asks for a stress mark never pays for the dictionary.
 */
export class StressDictionary {
  private dict = new Map<string, string>();
  private sortedKeysCache: string[] | undefined;
  /** Where a lazy dictionary reads from; undefined when the entries were handed to the constructor. */
  private readonly lazyPath: string | undefined;
  private lazyLoad: Promise<boolean> | undefined;
  private ready: boolean;

  /** Pass `lazyPath` only through `lazyFromFile`; with it the entries stay unread until `ensureLoaded()`. */
  constructor(data: Record<string, string>, lazyPath?: string) {
    this.lazyPath = lazyPath;
    this.ready = lazyPath === undefined;
    if (lazyPath === undefined) this.fill(data);
  }

  private fill(data: Record<string, string>): void {
    this.dict = new Map(Object.entries(data));
    this.sortedKeysCache = undefined;
    voiceLogger.info({ size: this.dict.size }, 'Stress dictionary loaded');
  }

  /** Sorted only when `findSimilar` first needs it: a plain lookup never pays for 555K sorted keys. */
  private get sortedKeys(): string[] {
    this.sortedKeysCache ??= [...this.dict.keys()].sort();
    return this.sortedKeysCache;
  }

  /**
   * Reads a lazy dictionary's file once (concurrent callers share the read). Resolves true when lookups can be
   * answered; false when the file could not be read or parsed, logged once and not retried, and every lookup
   * then finds nothing. An eager dictionary is always ready.
   */
  ensureLoaded(): Promise<boolean> {
    const path = this.lazyPath;
    if (path === undefined) return Promise.resolve(true);
    this.lazyLoad ??= this.loadLazyFile(path);
    return this.lazyLoad;
  }

  private async loadLazyFile(path: string): Promise<boolean> {
    try {
      this.fill(z.record(z.string(), z.string()).parse(await Bun.file(path).json()));
      return true;
    } catch (error) {
      voiceLogger.warn({ err: error, path }, 'Stress dictionary not loaded');
      return false;
    } finally {
      this.ready = true;
    }
  }

  /** A lazy dictionary answered before `ensureLoaded()` settled would report every word as unknown. */
  private assertReady(): void {
    if (!this.ready) throw new Error('StressDictionary used before ensureLoaded() settled');
  }

  lookup(word: string): string | null {
    this.assertReady();
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
    this.assertReady();
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

  /**
   * A dictionary that reads `path` on its first `ensureLoaded()`. A missing file fails here, at startup, as
   * before; a file that exists but cannot be parsed fails at the first load instead (logged, lookups find nothing).
   */
  static async lazyFromFile(path: string): Promise<StressDictionary> {
    if (!(await Bun.file(path).exists())) throw new Error(`Stress dictionary file not found: ${path}`);
    return new StressDictionary({}, path);
  }
}

// src/services/intent/intent-matcher.ts

import type { Intent } from '../../database/types.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { normalize, tokenize } from './normalizer.ts';

interface MatchResult {
  intentId: number;
  captures: Record<string, string>;
}

interface TriggerEntry {
  intentId: number;
  pattern: RegExp;
}

export class IntentMatcher {
  private phraseMap: Map<string, number> = new Map();
  private triggerIndex: Map<string, TriggerEntry[]> = new Map();

  /** Load approved intents into memory indexes */
  load(intents: Intent[]): void {
    this.phraseMap = new Map();
    this.triggerIndex = new Map();

    for (const intent of intents) {
      let phrases: string[];
      try {
        phrases = JSON.parse(intent.phrases) as string[];
      } catch {
        cmdLogger.error({ intentId: intent.id }, 'Intent has invalid phrases JSON, skipping');
        continue;
      }
      for (const phrase of phrases) {
        this.phraseMap.set(normalize(phrase), intent.id);
      }

      if (intent.pattern) {
        let triggerWords: string[];
        try {
          triggerWords = JSON.parse(intent.trigger_words) as string[];
        } catch {
          cmdLogger.error({ intentId: intent.id }, 'Intent has invalid trigger_words JSON, skipping pattern');
          continue;
        }
        const pattern = new RegExp(intent.pattern, 'i');
        const entry: TriggerEntry = { intentId: intent.id, pattern };
        for (const word of triggerWords) {
          const key = normalize(word);
          const existing = this.triggerIndex.get(key);
          if (existing) {
            existing.push(entry);
          } else {
            this.triggerIndex.set(key, [entry]);
          }
        }
      }
    }
  }

  /** Try to match message text against loaded intents.
   *  1. Normalize → exact lookup in phraseMap → return if found
   *  2. Tokenize → look up trigger words → collect candidate regexes
   *  3. Test candidates → return first match with captures
   *  4. Return null if nothing matches
   */
  match(text: string): MatchResult | null {
    const normalized = normalize(text);

    const exactId = this.phraseMap.get(normalized);
    if (exactId !== undefined) {
      return { intentId: exactId, captures: {} };
    }

    const words = tokenize(text);
    const seen = new Set<number>();
    const candidates: TriggerEntry[] = [];

    for (const word of words) {
      const entries = this.triggerIndex.get(word);
      if (!entries) continue;
      for (const entry of entries) {
        if (!seen.has(entry.intentId)) {
          seen.add(entry.intentId);
          candidates.push(entry);
        }
      }
    }

    for (const { intentId, pattern } of candidates) {
      const m = pattern.exec(normalized);
      if (m) {
        const captures: Record<string, string> = {};
        for (let i = 1; i < m.length; i++) {
          if (m[i] !== undefined) {
            captures[`$${i}`] = m[i];
          }
        }
        return { intentId, captures };
      }
    }

    return null;
  }
}

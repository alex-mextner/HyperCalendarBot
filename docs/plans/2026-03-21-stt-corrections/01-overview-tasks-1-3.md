> Part 1 of 3 of [STT Corrections Dictionary Implementation Plan](../2026-03-21-stt-corrections.md) — next: [02-tasks-4-7.md](02-tasks-4-7.md)

## File Map

| Action | Path |
|--------|------|
| Modify | `src/database/migrations.ts` — add migration 042 |
| **Create** | `src/database/repositories/stt-corrections.repository.ts` |
| Modify | `src/database/index.ts` — add `sttCorrections` field |
| **Create** | `src/services/voice/transcript-enricher.ts` |
| Modify | `src/services/voice/nova-streaming-stt.ts` — extend `onFinal` with `words` |
| Modify | `src/services/voice/flux-streaming-stt.ts` — extend `onEndOfTurn` with `words` |
| Modify | `src/services/voice/call-session.ts` — wire enricher |
| Modify | `src/services/ai/types.ts` — add `SttMeta`, `sttMeta?`, `sttCorrectionsRepo?`, `sttAdminPromotion?` |
| Modify | `src/services/ai/system-prompt.ts` — add STT metadata section |
| Modify | `src/bot/handlers/message.handler.ts` — wire enricher for Whisper path |
| Modify | `src/services/ai/tools.ts` — add 4 tool schemas |
| **Create** | `src/services/ai/tool-handlers/dict.ts` |
| Modify | `src/services/ai/tool-executor.ts` — dispatch dict tools |
| **Create** | `src/bot/commands/dict.ts` |
| Modify | `src/bot/index.ts` — register `/dict` command and callback |
| Modify | `src/config/constants.ts` — add dict bilingual strings |
| Modify | `src/index.ts` — wire `sttCorrectionsRepo` into CallSession |
| **Create** | `test/database/repositories/stt-corrections.repository.test.ts` |
| **Create** | `test/services/voice/transcript-enricher.test.ts` |
| Modify | `test/services/voice/nova-streaming-stt.test.ts` |
| Modify | `test/services/voice/flux-streaming-stt.test.ts` |
| Modify | `test/services/voice/call-session.test.ts` |
| **Create** | `test/services/ai/tool-handlers/dict.test.ts` |

---

## Task 1: DB Migration + SttCorrectionsRepository

**Files:**
- Modify: `src/database/migrations.ts` (after line with `'041_assistant_enabled'`)
- Create: `src/database/repositories/stt-corrections.repository.ts`
- Modify: `src/database/index.ts`
- Create: `test/database/repositories/stt-corrections.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/database/repositories/stt-corrections.repository.test.ts
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SttCorrectionsRepository } from '../../../src/database/repositories/stt-corrections.repository.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { runMigrations } from '../../../src/database/schema.ts';

let db: Database;
let repo: SttCorrectionsRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  repo = new SttCorrectionsRepository(db);
});

afterEach(() => db.close());

describe('add + findMerged', () => {
  test('user entry overrides global entry with same wrong key', () => {
    repo.add(null, 'визором', 'виза-ран');
    repo.add(42, 'визором', 'визор');
    const merged = repo.findMerged(42);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ wrong: 'визором', correct: 'визор', isGlobal: false });
  });

  test('global entry visible to all users', () => {
    repo.add(null, 'визором', 'виза-ран');
    const merged = repo.findMerged(99);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ wrong: 'визором', correct: 'виза-ран', isGlobal: true });
  });

  test('normalizes to lowercase-trimmed', () => {
    repo.add(1, '  Визором  ', '  Виза-ран  ');
    const merged = repo.findMerged(1);
    expect(merged[0]).toMatchObject({ wrong: 'визором', correct: 'виза-ран' });
  });

  test('upsert updates correct value', () => {
    repo.add(1, 'питер', 'Петербург');
    repo.add(1, 'питер', 'Санкт-Петербург');
    const merged = repo.findMerged(1);
    expect(merged[0]?.correct).toBe('санкт-петербург');
  });

  test('delete removes user entry', () => {
    repo.add(1, 'питер', 'Санкт-Петербург');
    repo.delete(1, 'питер');
    expect(repo.findMerged(1)).toHaveLength(0);
  });

  test('findByLevel returns only that level', () => {
    repo.add(null, 'один', 'one');
    repo.add(5, 'два', 'two');
    expect(repo.findByLevel(null)).toHaveLength(1);
    expect(repo.findByLevel(5)).toHaveLength(1);
    expect(repo.findByLevel(5)[0]?.wrong).toBe('два');
  });

  test('no duplicate global rows', () => {
    repo.add(null, 'тест', 'test');
    repo.add(null, 'тест', 'test2');
    const rows = repo.findByLevel(null);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.correct).toBe('test2');
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
cd /Users/ultra/xp/hypercalendarbot/.worktrees/feature/stt-corrections
bun test test/database/repositories/stt-corrections.repository.test.ts
```
Expected: FAIL — `SttCorrectionsRepository` not found

- [ ] **Step 3: Add migration 042 to migrations.ts**

Add after the `041_assistant_enabled` entry:

```ts
{
  name: '042_stt_corrections',
  up: (db) => {
    db.exec(`
      CREATE TABLE stt_corrections (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER REFERENCES users(telegram_id) ON DELETE CASCADE,
        wrong      TEXT NOT NULL,
        correct    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX stt_corrections_unique
        ON stt_corrections(COALESCE(user_id, -1), wrong);
      CREATE INDEX stt_corrections_user ON stt_corrections(user_id);
    `);
  },
},
```

- [ ] **Step 4: Create SttCorrectionsRepository**

```ts
// src/database/repositories/stt-corrections.repository.ts
import type { Database } from 'bun:sqlite';

export interface CorrectionRow {
  wrong: string;
  correct: string;
  isGlobal: boolean;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export class SttCorrectionsRepository {
  constructor(private readonly db: Database) {}

  add(userId: number | null, wrong: string, correct: string): void {
    this.db
      .prepare(`
        INSERT INTO stt_corrections (user_id, wrong, correct)
        VALUES (?, ?, ?)
        ON CONFLICT(COALESCE(user_id, -1), wrong)
        DO UPDATE SET correct = excluded.correct, created_at = datetime('now')
      `)
      .run(userId, normalize(wrong), normalize(correct));
  }

  delete(userId: number | null, wrong: string): void {
    this.db
      .prepare('DELETE FROM stt_corrections WHERE user_id IS ? AND wrong = ?')
      .run(userId, normalize(wrong));
  }

  findMerged(userId: number): CorrectionRow[] {
    // Global entries + user entries; user entry wins on same `wrong`
    return this.db
      .prepare(`
        SELECT
          COALESCE(u.wrong, g.wrong)   AS wrong,
          COALESCE(u.correct, g.correct) AS correct,
          (u.id IS NULL)               AS isGlobal
        FROM (SELECT * FROM stt_corrections WHERE user_id IS NULL) g
        FULL OUTER JOIN
          (SELECT * FROM stt_corrections WHERE user_id = ?) u
          ON g.wrong = u.wrong
      `)
      .all(userId) as CorrectionRow[];
  }

  findByLevel(userId: number | null): CorrectionRow[] {
    if (userId === null) {
      return (this.db
        .prepare('SELECT wrong, correct FROM stt_corrections WHERE user_id IS NULL')
        .all() as { wrong: string; correct: string }[])
        .map((r) => ({ ...r, isGlobal: true }));
    }
    return (this.db
      .prepare('SELECT wrong, correct FROM stt_corrections WHERE user_id = ?')
      .all(userId) as { wrong: string; correct: string }[])
      .map((r) => ({ ...r, isGlobal: false }));
  }
}
```

> **Note on FULL OUTER JOIN:** SQLite supports it since 3.39.0 (2022-07-21). Bun bundles SQLite 3.46+, so this is safe. If you hit issues in tests, use a UNION-based alternative:
> ```sql
> SELECT wrong, correct, 1 AS isGlobal FROM stt_corrections WHERE user_id IS NULL
>   AND wrong NOT IN (SELECT wrong FROM stt_corrections WHERE user_id = ?)
> UNION ALL
> SELECT wrong, correct, 0 AS isGlobal FROM stt_corrections WHERE user_id = ?
> ```

- [ ] **Step 5: Wire into DatabaseService**

In `src/database/index.ts`, add import and field:
```ts
import { SttCorrectionsRepository } from './repositories/stt-corrections.repository.ts';
// in class body:
readonly sttCorrections: SttCorrectionsRepository;
// in constructor after other repos:
this.sttCorrections = new SttCorrectionsRepository(this.db);
```

- [ ] **Step 6: Run tests — confirm they pass**

```bash
bun test test/database/repositories/stt-corrections.repository.test.ts
```
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add src/database/migrations.ts src/database/repositories/stt-corrections.repository.ts src/database/index.ts test/database/repositories/stt-corrections.repository.test.ts
git commit -m "feat(stt): migration 042 + SttCorrectionsRepository"
```

---

## Task 2: TranscriptEnricher

**Files:**
- Create: `src/services/voice/transcript-enricher.ts`
- Create: `test/services/voice/transcript-enricher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/services/voice/transcript-enricher.test.ts
import { describe, expect, test } from 'bun:test';
import { TranscriptEnricher } from '../../../src/services/voice/transcript-enricher.ts';

describe('phonetic normalization', () => {
  test('ё→е, й→и, ъ/ь removed, double consonants reduced', () => {
    // internal: tested via enricher behavior
    const result = TranscriptEnricher.enrich({
      transcript: 'ёлка',
      corrections: [{ wrong: 'елка', correct: 'ёлка' }],
    });
    // 'ёлка' normalizes to 'елка', matches dict wrong='елка'
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]?.candidate).toBe('ёлка');
  });
});

describe('enrich — dictionary matching', () => {
  test('exact phonetic match for short word (Levenshtein)', () => {
    const result = TranscriptEnricher.enrich({
      transcript: 'питер',
      corrections: [{ wrong: 'питер', correct: 'Санкт-Петербург' }],
    });
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({
      word: 'питер',
      candidate: 'Санкт-Петербург',
    });
  });

  test('fuzzy Levenshtein match within threshold for short word', () => {
    // 'визором' (7 chars) matches 'визором' exactly — score 1.0
    const result = TranscriptEnricher.enrich({
      transcript: 'визором',
      corrections: [{ wrong: 'визором', correct: 'виза-ран' }],
    });
    expect(result.corrections[0]?.word).toBe('визором');
  });

  test('no match when distance too high for short word', () => {
    // 'abc' vs 'xyz' — distance 3, len 3, threshold floor(3/2)=1 → no match
    const result = TranscriptEnricher.enrich({
      transcript: 'abc',
      corrections: [{ wrong: 'xyz', correct: 'something' }],
    });
    expect(result.corrections).toHaveLength(0);
  });

  test('trigram Jaccard for long word (>6 chars)', () => {
    // 'предположительно' vs 'предполагительно' — should match (high trigram overlap)
    const result = TranscriptEnricher.enrich({
      transcript: 'предположительно',
      corrections: [{ wrong: 'предполагительно', correct: 'предположительно' }],
    });
    expect(result.corrections[0]?.candidate).toBe('предположительно');
  });

  test('multi-word wrong entry matched as ngram', () => {
    const result = TranscriptEnricher.enrich({
      transcript: 'я иду домой сегодня',
      corrections: [{ wrong: 'иду домой', correct: 'еду домой' }],
    });
    expect(result.corrections[0]?.candidate).toBe('еду домой');
  });

  test('wrong==correct entries excluded from corrections output', () => {
    const result = TranscriptEnricher.enrich({
      transcript: 'питер',
      corrections: [{ wrong: 'питер', correct: 'питер' }],
    });
    expect(result.corrections).toHaveLength(0);
  });

  test('returns top-3 candidates max', () => {
    const corrections = [
      { wrong: 'тест1', correct: 'c1' },
      { wrong: 'тест2', correct: 'c2' },
      { wrong: 'тест3', correct: 'c3' },
      { wrong: 'тест4', correct: 'c4' },
    ];
    // 'тест' (4 chars, Levenshtein≤2): тест1,тест2,тест3,тест4 all within threshold
    const result = TranscriptEnricher.enrich({ transcript: 'тест', corrections });
    expect(result.corrections.length).toBeLessThanOrEqual(3);
  });
});

describe('enrich — confidence annotations', () => {
  test('low-confidence words annotated inline', () => {
    const result = TranscriptEnricher.enrich({
      transcript: 'визором купил',
      words: [
        { word: 'визором', confidence: 0.41 },
        { word: 'купил', confidence: 0.9 },
      ],
      corrections: [],
    });
    expect(result.annotated).toBe('визором[0.41] купил');
    expect(result.lowConfidence).toHaveLength(1);
    expect(result.lowConfidence[0]).toMatchObject({ word: 'визором', confidence: 0.41 });
  });

  test('no words → annotated equals transcript', () => {
    const result = TranscriptEnricher.enrich({
      transcript: 'привет мир',
      corrections: [],
    });
    expect(result.annotated).toBe('привет мир');
    expect(result.lowConfidence).toHaveLength(0);
  });

  test('confidence threshold is <0.6', () => {
    const result = TranscriptEnricher.enrich({
      transcript: 'слово',
      words: [{ word: 'слово', confidence: 0.6 }],
      corrections: [],
    });
    expect(result.annotated).toBe('слово'); // 0.6 is NOT below threshold
  });
});
```

- [ ] **Step 2: Run — confirm fails**

```bash
bun test test/services/voice/transcript-enricher.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement TranscriptEnricher**

```ts
// src/services/voice/transcript-enricher.ts

const CONFIDENCE_THRESHOLD = 0.6;

export interface WordEntry {
  word: string;
  confidence: number;
}

export interface EnrichInput {
  transcript: string;
  words?: WordEntry[];
  corrections: { wrong: string; correct: string }[];
}

export interface CorrectionMatch {
  word: string;
  candidate: string;
  score: number;
}

export interface EnrichedTranscript {
  annotated: string;
  corrections: CorrectionMatch[];
  lowConfidence: WordEntry[];
}

// Phonetic normalization for Russian
function phonetic(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/й/g, 'и')
    .replace(/[ъь]/g, '')
    .replace(/([бвгджзклмнпрстфхцчшщ])\1+/g, '$1')
    .replace(/б(?=[^аеёиоуыэюяaeiou]|$)/g, 'п')
    .replace(/в(?=[^аеёиоуыэюяaeiou]|$)/g, 'ф')
    .replace(/г(?=[^аеёиоуыэюяaeiou]|$)/g, 'к')
    .replace(/д(?=[^аеёиоуыэюяaeiou]|$)/g, 'т')
    .replace(/ж(?=[^аеёиоуыэюяaeiou]|$)/g, 'ш')
    .replace(/з(?=[^аеёиоуыэюяaeiou]|$)/g, 'с');
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

function trigrams(s: string): Set<string> {
  const result = new Set<string>();
  const padded = `  ${s} `;
  for (let i = 0; i < padded.length - 2; i++) {
    result.add(padded.slice(i, i + 3));
  }
  return result;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function scoreMatch(transcriptNorm: string, wrongNorm: string): number | null {
  const len = transcriptNorm.length;
  if (len <= 6) {
    const dist = levenshtein(transcriptNorm, wrongNorm);
    const threshold = Math.floor(len / 2);
    if (dist > threshold) return null;
    return 1 - dist / Math.max(len, wrongNorm.length);
  }
  const score = jaccard(trigrams(transcriptNorm), trigrams(wrongNorm));
  return score >= 0.45 ? score : null;
}

export class TranscriptEnricher {
  static enrich(input: EnrichInput): EnrichedTranscript {
    const { transcript, words, corrections } = input;

    // Build confidence map from words array
    const confidenceMap = new Map<string, number>();
    if (words) {
      for (const w of words) {
        confidenceMap.set(w.word.toLowerCase(), w.confidence);
      }
    }

    // Annotate low-confidence words inline
    const transcriptTokens = transcript.split(/\s+/);
    const lowConfidence: WordEntry[] = [];
    const annotatedTokens = transcriptTokens.map((token) => {
      const conf = confidenceMap.get(token.toLowerCase());
      if (conf !== undefined && conf < CONFIDENCE_THRESHOLD) {
        lowConfidence.push({ word: token, confidence: conf });
        return `${token}[${conf.toFixed(2)}]`;
      }
      return token;
    });
    const annotated = annotatedTokens.join(' ');

    // Dictionary matching — skip wrong==correct entries
    const matchable = corrections.filter((c) => c.wrong !== c.correct);
    const allMatches: CorrectionMatch[] = [];

    for (const correction of matchable) {
      const wrongTokens = correction.wrong.split(/\s+/);
      const n = wrongTokens.length;

      if (n === 1) {
        // Single-word match against each transcript token
        const wrongNorm = phonetic(correction.wrong);
        for (const token of transcriptTokens) {
          const tokenNorm = phonetic(token);
          const score = scoreMatch(tokenNorm, wrongNorm);
          if (score !== null) {
            allMatches.push({ word: token, candidate: correction.correct, score });
          }
        }
      } else {
        // Multi-word: check n-grams of same token count
        const wrongNorm = wrongTokens.map(phonetic).join(' ');
        for (let i = 0; i <= transcriptTokens.length - n; i++) {
          const ngram = transcriptTokens.slice(i, i + n);
          const ngramNorm = ngram.map(phonetic).join(' ');
          const score = scoreMatch(ngramNorm, wrongNorm);
          if (score !== null) {
            allMatches.push({ word: ngram.join(' '), candidate: correction.correct, score });
          }
        }
      }
    }

    // Sort by score desc, take top-3
    allMatches.sort((a, b) => b.score - a.score);
    const top3 = allMatches.slice(0, 3);

    return { annotated, corrections: top3, lowConfidence };
  }

  /** Same as enrich but returns top-5 (for dict_search_phonetic tool). */
  static search(
    word: string,
    corrections: { wrong: string; correct: string }[],
  ): CorrectionMatch[] {
    const wordNorm = phonetic(word);
    const results: CorrectionMatch[] = [];
    for (const c of corrections) {
      const wrongNorm = phonetic(c.wrong);
      const score = scoreMatch(wordNorm, wrongNorm);
      if (score !== null) {
        results.push({ word, candidate: c.correct, score });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 5);
  }
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
bun test test/services/voice/transcript-enricher.test.ts
```
Expected: all pass. If word-final devoicing regex needs adjustment, fix the `phonetic()` function — the regex must only devoice at word boundaries, not mid-word.

- [ ] **Step 5: Commit**

```bash
git add src/services/voice/transcript-enricher.ts test/services/voice/transcript-enricher.test.ts
git commit -m "feat(stt): TranscriptEnricher with phonetic normalization and Levenshtein/Jaccard"
```

---

## Task 3: STT Events Extension (Nova + Flux)

**Files:**
- Modify: `src/services/voice/nova-streaming-stt.ts`
- Modify: `src/services/voice/flux-streaming-stt.ts`
- Modify: `test/services/voice/nova-streaming-stt.test.ts`
- Modify: `test/services/voice/flux-streaming-stt.test.ts`

- [ ] **Step 1: Add failing tests for words in callbacks**

In `test/services/voice/nova-streaming-stt.test.ts`, add a test that `onFinal` receives the `words` array:

```ts
test('onFinal passes words from channel.alternatives[0].words', () => {
  let capturedWords: { word: string; confidence: number }[] | undefined;
  stt.connect({
    onInterim: () => {},
    onFinal: (_t, words) => { capturedWords = words; },
    onError: () => {},
  });
  fireMessage({
    is_final: true,
    channel: {
      alternatives: [{
        transcript: 'привет',
        words: [{ word: 'привет', confidence: 0.95 }],
      }],
    },
  });
  expect(capturedWords).toEqual([{ word: 'привет', confidence: 0.95 }]);
});
```

In `test/services/voice/flux-streaming-stt.test.ts`, add a test that `onEndOfTurn` receives `words`:

```ts
test('onEndOfTurn passes words from Flux response', () => {
  let capturedWords: { word: string; confidence: number }[] | undefined;
  stt.connect({
    onStartOfTurn: () => {},
    onEndOfTurn: (_confidence, _transcript, words) => { capturedWords = words; },
    onInterim: () => {},
    onError: () => {},
  });
  fireMessage({
    type: 'TurnInfo',
    event: 'EndOfTurn',
    transcript: 'hello',
    end_of_turn_confidence: 0.8,
    words: [{ word: 'hello', confidence: 0.92 }],
  });
  expect(capturedWords).toEqual([{ word: 'hello', confidence: 0.92 }]);
});
```

- [ ] **Step 2: Run — confirm fails**

```bash
bun test test/services/voice/nova-streaming-stt.test.ts test/services/voice/flux-streaming-stt.test.ts
```

- [ ] **Step 3: Update NovaStreamingSTT**

In `src/services/voice/nova-streaming-stt.ts`:

1. Extend event interface:
```ts
interface NovaStreamingSTTEvents {
  onInterim: (transcript: string) => void;
  onFinal: (transcript: string, words?: Array<{ word: string; confidence: number }>) => void;
  onError: (err: Error) => void;
}
```

2. Update parsed type and `onFinal` call:
```ts
const data = JSON.parse(event.data as string) as {
  is_final: boolean;
  channel?: {
    alternatives?: Array<{
      transcript: string;
      words?: Array<{ word: string; confidence: number }>;
    }>;
  };
};
const alt = data.channel?.alternatives?.[0];
const transcript = alt?.transcript ?? '';
if (!transcript) return;
if (data.is_final) events.onFinal(transcript, alt?.words);
else events.onInterim(transcript);
```

- [ ] **Step 4: Update FluxStreamingSTT**

In `src/services/voice/flux-streaming-stt.ts`:

1. Extend event interface:
```ts
interface FluxStreamingSTTEvents {
  onStartOfTurn: () => void;
  onEndOfTurn: (confidence: number, transcript: string, words?: Array<{ word: string; confidence: number }>) => void;
  onInterim: (transcript: string) => void;
  onError: (err: Error) => void;
}
```

2. Update parsed type and `onEndOfTurn` call:
```ts
const data = JSON.parse(event.data as string) as {
  type?: string;
  event?: string;
  transcript?: string;
  end_of_turn_confidence?: number;
  words?: Array<{ word: string; confidence: number }>;
};
// ...
if (data.event === 'EndOfTurn') {
  events.onEndOfTurn(data.end_of_turn_confidence ?? 1.0, data.transcript ?? '', data.words);
  return;
}
```

- [ ] **Step 5: Run tests — confirm they pass**

```bash
bun test test/services/voice/nova-streaming-stt.test.ts test/services/voice/flux-streaming-stt.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/services/voice/nova-streaming-stt.ts src/services/voice/flux-streaming-stt.ts test/services/voice/nova-streaming-stt.test.ts test/services/voice/flux-streaming-stt.test.ts
git commit -m "feat(stt): extend Nova/Flux onFinal/onEndOfTurn with words array"
```

---


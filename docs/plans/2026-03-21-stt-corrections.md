# STT Corrections Dictionary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user and global STT post-processing dictionary with phonetic matching, agent tools, and `/dict` bot command — zero AI (Haiku) in the pipeline.

**Architecture:** `TranscriptEnricher` runs Levenshtein/Jaccard against `SttCorrectionsRepository` after each transcript, annotates low-confidence words inline, and attaches `SttMeta` to `AgentContext` so the agent can ask for clarification and call `dict_*` tools to manage the dictionary. Four new AI tools. One bot command with inline-keyboard CRUD.

**Tech Stack:** Bun, bun:sqlite, TypeScript, GramIO, Anthropic SDK.

---

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

## Task 4: CallSession Integration

**Files:**
- Modify: `src/services/voice/call-session.ts`
- Modify: `src/index.ts`
- Modify: `test/services/voice/call-session.test.ts`

- [ ] **Step 1: Add failing tests**

In `test/services/voice/call-session.test.ts`, add tests for enricher wiring:

```ts
test('onEnoughToRespond enriches transcript with corrections', async () => {
  // Build a session with sttCorrectionsRepo that returns one correction
  const corrections = [{ wrong: 'визором', correct: 'виза-ран', isGlobal: true }];
  const mockRepo = {
    findMerged: () => corrections,
    add: () => {},
    delete: () => {},
    findByLevel: () => [],
  };
  let capturedCtx: AgentContext | undefined;
  const cfg = buildTestCfg({
    sttCorrectionsRepo: mockRepo,
    agent: { run: async (ctx) => { capturedCtx = ctx; return {}; } },
  });
  const session = CallSession.create(cfg);
  // simulate VAD_START, Nova final transcript, VAD_END
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  cfg.createNovaStt().fireOnFinal('визором', [{ word: 'визором', confidence: 0.41 }]);
  await session.handleMessage(JSON.stringify({ type: 'VAD_END' }));
  await Bun.sleep(10);
  expect(capturedCtx?.messageText).toBe('визором[0.41]');
  expect(capturedCtx?.sttMeta?.corrections[0]?.candidate).toBe('виза-ран');
});

test('lastWords reset on VAD_START', async () => {
  // Verify that a new VAD cycle starts with no words from previous cycle
  // (simulate two VAD cycles, only second cycle's words reach agent)
  // ... test implementation
});
```

> Note: the test file currently uses a `buildTestCfg` helper. Extend it to accept `sttCorrectionsRepo` and verify the enricher path.

- [ ] **Step 2: Run — confirm fails**

```bash
bun test test/services/voice/call-session.test.ts
```

- [ ] **Step 3: Update CallSessionConfig and CallSession**

In `src/services/voice/call-session.ts`:

Add import:
```ts
import { TranscriptEnricher } from './transcript-enricher.ts';
import type { SttCorrectionsRepository } from '../../database/repositories/stt-corrections.repository.ts';
```

Add to `CallSessionConfig`:
```ts
sttCorrectionsRepo?: SttCorrectionsRepository;
```

Add private field to `CallSession`:
```ts
private lastWords: Array<{ word: string; confidence: number }> | undefined;
```

In `onVadStart()`, reset `lastWords`:
```ts
private onVadStart(): void {
  this.lastWords = undefined;  // add this line
  // ... rest unchanged
  if (this.cfg.language === 'ru') {
    this.novaStt = this.cfg.createNovaStt();
    this.novaStt.connect({
      onInterim: (t: string) => this.onNovaInterim(t),
      onFinal: (t: string, words) => {
        this.rollingTranscript = t;
        this.lastWords = words;  // capture words
      },
      // ...
    });
  }
}
```

For Flux (EN), in `onCallConnected()` update `onEndOfTurn`:
```ts
onEndOfTurn: (confidence: number, finalTranscript: string, words) => {
  if (finalTranscript) this.rollingTranscript = finalTranscript;
  this.lastWords = words;  // capture words
  // ...
},
```

Also add reset in `onStartOfTurn` (Flux):
```ts
onStartOfTurn: () => {
  this.lastWords = undefined;
  // ...
},
```

In `onEnoughToRespond()`, replace the `const transcript = this.rollingTranscript;` block:
```ts
const transcript = this.rollingTranscript;
this.rollingTranscript = '';
const words = this.lastWords;
this.lastWords = undefined;

let messageText = transcript;
let sttMeta: import('../ai/types.ts').SttMeta | undefined;

if (this.cfg.sttCorrectionsRepo) {
  const corrections = this.cfg.sttCorrectionsRepo.findMerged(this.cfg.userId);
  const enriched = TranscriptEnricher.enrich({ transcript, words, corrections });
  messageText = enriched.annotated;
  if (enriched.corrections.length > 0 || enriched.lowConfidence.length > 0) {
    sttMeta = { corrections: enriched.corrections, lowConfidence: enriched.lowConfidence };
  }
}

this.runAgent(messageText, sttMeta).catch((err) => {
  voiceLogger.error({ err, sessionId: this.cfg.sessionId }, 'Agent error during call');
});
```

Update `runAgent` signature:
```ts
private async runAgent(transcript: string, sttMeta?: import('../ai/types.ts').SttMeta): Promise<void> {
  // ...
  const ctx = {
    ...(this.cfg.agentContextBase ?? {}),
    user,
    chatId: this.cfg.userId,
    messageText: transcript,
    inputMode: 'live_call',
    isGroup: false,
    sttMeta,
    sttCorrectionsRepo: this.cfg.sttCorrectionsRepo,
  } as AgentContext;
  // ...
}
```

- [ ] **Step 4: Wire sttCorrectionsRepo in src/index.ts**

In the `CallSession.create(...)` call (around line 279), add to `agentContextBase` or directly to config:
```ts
CallSession.create({
  // ...existing fields...
  sttCorrectionsRepo: db.sttCorrections,
  agentContextBase: {
    // ...existing...
    sttCorrectionsRepo: db.sttCorrections,
  },
}),
```

- [ ] **Step 5: Run tests — confirm they pass**

```bash
bun test test/services/voice/call-session.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/services/voice/call-session.ts src/index.ts test/services/voice/call-session.test.ts
git commit -m "feat(stt): wire TranscriptEnricher into CallSession"
```

---

## Task 5: AgentContext Types + System Prompt

**Files:**
- Modify: `src/services/ai/types.ts`
- Modify: `src/services/ai/system-prompt.ts`

- [ ] **Step 1: Add SttMeta and update AgentContext in types.ts**

Add before `AgentContext` interface:
```ts
export interface SttMeta {
  corrections: Array<{ word: string; candidate: string; score: number }>;
  lowConfidence: Array<{ word: string; confidence: number }>;
}
```

Add to `AgentContext` (near the end, before `agentDispatcher`):
```ts
sttMeta?: SttMeta;
sttCorrectionsRepo?: import('../../database/repositories/stt-corrections.repository.ts').SttCorrectionsRepository;
/** Set by dict_add tool when acting user is botAdminId. Caller sends promotion keyboard after turn. */
sttAdminPromotion?: { wrong: string; correct: string };
```

- [ ] **Step 2: Update system-prompt.ts**

In `buildSystemPrompt()`, add STT metadata section. Find where other optional sections are appended (e.g., `eventsWindowSection`) and add:

```ts
let sttMetaSection = '';
if (ctx.sttMeta) {
  const { corrections, lowConfidence } = ctx.sttMeta;
  if (corrections.length > 0 || lowConfidence.length > 0) {
    const lines: string[] = ['STT metadata for this turn:'];
    if (corrections.length > 0) {
      for (const c of corrections) {
        lines.push(`- Possible correction: ${c.word} → ${c.candidate} (score ${c.score.toFixed(2)})`);
      }
    }
    if (lowConfidence.length > 0) {
      const lcList = lowConfidence.map((w) => `${w.word}: ${w.confidence.toFixed(2)}`).join(', ');
      lines.push(`- Low-confidence words: [${lcList}]`);
    }
    lines.push('');
    lines.push(
      'If any of these words seem relevant, consider asking the user to confirm what they meant. Use dict_add to save confirmed corrections.',
    );
    sttMetaSection = `\n${lines.join('\n')}`;
  }
}
```

Include `sttMetaSection` in the returned string.

- [ ] **Step 3: Run all tests — confirm no regression**

```bash
bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/types.ts src/services/ai/system-prompt.ts
git commit -m "feat(stt): SttMeta in AgentContext, STT metadata section in system prompt"
```

---

## Task 6: Whisper Path Integration

**Files:**
- Modify: `src/bot/handlers/message.handler.ts`

The Whisper path is `handleVoiceMessage()` (around line 280). After getting `transcription` from `deps.transcriptionService!.transcribe(audioBuffer)`:

- [ ] **Step 1: Add `sttCorrectionsRepo` to MessageHandlerDeps**

Find the `MessageHandlerDeps` interface in `message.handler.ts`. Add:
```ts
sttCorrectionsRepo?: import('../../database/repositories/stt-corrections.repository.ts').SttCorrectionsRepository;
```

- [ ] **Step 2: Wire enricher in handleVoiceMessage**

After the `transcription` check, before building `agentContext`:

```ts
import { TranscriptEnricher } from '../../services/voice/transcript-enricher.ts';
import type { SttMeta } from '../../services/ai/types.ts';

// In handleVoiceMessage, after: const transcription = await deps.transcriptionService!.transcribe(...)
let messageText = transcription;
let sttMeta: SttMeta | undefined;

if (deps.sttCorrectionsRepo) {
  const corrections = deps.sttCorrectionsRepo.findMerged(user.telegram_id);
  const enriched = TranscriptEnricher.enrich({ transcript: transcription, corrections });
  // annotated === transcript for Whisper (no words), but corrections still run
  if (enriched.corrections.length > 0) {
    sttMeta = { corrections: enriched.corrections, lowConfidence: [] };
  }
}

const agentContext: AgentContext = {
  ...buildAgentContextFactory(deps)(user, Number(chatId), messageText),
  inputMode: 'voice_message',
  sttMeta,
  sttCorrectionsRepo: deps.sttCorrectionsRepo,
};
```

- [ ] **Step 3: Wire in bot/index.ts and src/index.ts**

Pass `sttCorrectionsRepo: db.sttCorrections` into the `MessageHandlerDeps` object where `createMessageHandler` is called.

- [ ] **Step 4: Run tests**

```bash
bun test test/bot/handlers/message.handler.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers/message.handler.ts src/bot/index.ts
git commit -m "feat(stt): wire TranscriptEnricher into Whisper voice message path"
```

---

## Task 7: AI Tools (dict_*)

**Files:**
- Modify: `src/services/ai/tools.ts` — add 4 tool schemas
- Create: `src/services/ai/tool-handlers/dict.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/config/constants.ts` — add bilingual strings
- Create: `test/services/ai/tool-handlers/dict.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/services/ai/tool-handlers/dict.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SttCorrectionsRepository } from '../../../../src/database/repositories/stt-corrections.repository.ts';
import { migrations } from '../../../../src/database/migrations.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleDictAdd, handleDictDelete, handleDictList, handleDictSearch } from '../../../../src/services/ai/tool-handlers/dict.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

function makeDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function makeCtx(userId: number, overrides: Partial<AgentContext> = {}): AgentContext {
  const db = makeDb();
  const repo = new SttCorrectionsRepository(db);
  return {
    user: { telegram_id: userId, language: 'ru' } as never,
    sttCorrectionsRepo: repo,
    ...overrides,
  } as AgentContext;
}

test('dict_add adds entry and returns success', () => {
  const ctx = makeCtx(1);
  const result = handleDictAdd({ wrong: 'визором', correct: 'виза-ран' }, ctx);
  expect(result.success).toBe(true);
  const entries = ctx.sttCorrectionsRepo!.findMerged(1);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.candidate ?? entries[0]?.correct).toBe('виза-ран');
});

test('dict_add sets sttAdminPromotion when user is admin', () => {
  const ctx = makeCtx(42, { botAdminId: 42 });
  handleDictAdd({ wrong: 'тест', correct: 'тест2' }, ctx);
  expect(ctx.sttAdminPromotion).toMatchObject({ wrong: 'тест', correct: 'тест2' });
});

test('dict_add does not set sttAdminPromotion for non-admin', () => {
  const ctx = makeCtx(1, { botAdminId: 99 });
  handleDictAdd({ wrong: 'тест', correct: 'тест2' }, ctx);
  expect(ctx.sttAdminPromotion).toBeUndefined();
});

test('dict_delete removes entry', () => {
  const ctx = makeCtx(1);
  ctx.sttCorrectionsRepo!.add(1, 'питер', 'Петербург');
  const result = handleDictDelete({ wrong: 'питер' }, ctx);
  expect(result.success).toBe(true);
  expect(ctx.sttCorrectionsRepo!.findMerged(1)).toHaveLength(0);
});

test('dict_delete returns error for global entry by non-admin', () => {
  const ctx = makeCtx(1, { botAdminId: 99 });
  ctx.sttCorrectionsRepo!.add(null, 'глобал', 'global');
  // Trying to delete an entry that only exists globally — repo.findByLevel(userId) won't have it
  const result = handleDictDelete({ wrong: 'глобал' }, ctx);
  expect(result.success).toBe(false);
});

test('dict_list returns merged dictionary', () => {
  const ctx = makeCtx(1);
  ctx.sttCorrectionsRepo!.add(null, 'один', 'one');
  ctx.sttCorrectionsRepo!.add(1, 'два', 'two');
  const result = handleDictList({}, ctx);
  expect(result.success).toBe(true);
  expect(result.data).toHaveLength(2);
});

test('dict_search returns top-5 phonetic matches', () => {
  const ctx = makeCtx(1);
  ctx.sttCorrectionsRepo!.add(1, 'питер', 'Санкт-Петербург');
  const result = handleDictSearch({ word: 'питер' }, ctx);
  expect(result.success).toBe(true);
  const data = result.data as { candidate: string }[];
  expect(data[0]?.candidate).toBe('санкт-петербург');
});
```

- [ ] **Step 2: Run — confirm fails**

```bash
bun test test/services/ai/tool-handlers/dict.test.ts
```

- [ ] **Step 3: Add bilingual strings to constants.ts**

In `MSG.ru.aiTools` and `MSG.en.aiTools`, add a `dict` namespace:

```ts
// ru:
dict: {
  added: (wrong: string, correct: string) => `✅ Добавлено: «${wrong}» → «${correct}»`,
  deleted: (wrong: string) => `🗑 Удалено: «${wrong}»`,
  notFound: 'Такое исправление не найдено в личном словаре.',
  globalOnly: 'Это глобальная запись — её может удалять только администратор.',
  listEmpty: 'Словарь пуст.',
  searchEmpty: (word: string) => `Совпадений для «${word}» не найдено.`,
  searchResults: (word: string, count: number) => `Совпадения для «${word}» (${count}):`,
},
// en:
dict: {
  added: (wrong: string, correct: string) => `✅ Added: "${wrong}" → "${correct}"`,
  deleted: (wrong: string) => `🗑 Deleted: "${wrong}"`,
  notFound: 'Entry not found in your personal dictionary.',
  globalOnly: 'This is a global entry — only the admin can delete it.',
  listEmpty: 'Dictionary is empty.',
  searchEmpty: (word: string) => `No matches for "${word}".`,
  searchResults: (word: string, count: number) => `Matches for "${word}" (${count}):`,
},
```

- [ ] **Step 4: Create tool handler**

```ts
// src/services/ai/tool-handlers/dict.ts
import { t } from '../../../config/constants.ts';
import { TranscriptEnricher } from '../../voice/transcript-enricher.ts';
import type { AgentContext, ToolResult } from '../types.ts';

interface DictAddInput { wrong: string; correct: string; }
interface DictDeleteInput { wrong: string; }
interface DictSearchInput { word: string; }

export function handleDictAdd(input: DictAddInput, ctx: AgentContext): ToolResult {
  const repo = ctx.sttCorrectionsRepo;
  if (!repo) return { success: false, error: 'STT corrections not available' };
  const lang = ctx.user.language as 'ru' | 'en';
  repo.add(ctx.user.telegram_id, input.wrong, input.correct);
  if (ctx.botAdminId && ctx.user.telegram_id === ctx.botAdminId) {
    ctx.sttAdminPromotion = { wrong: input.wrong, correct: input.correct };
  }
  return { success: true, output: t(lang).aiTools.dict.added(input.wrong, input.correct) };
}

export function handleDictDelete(input: DictDeleteInput, ctx: AgentContext): ToolResult {
  const repo = ctx.sttCorrectionsRepo;
  if (!repo) return { success: false, error: 'STT corrections not available' };
  const lang = ctx.user.language as 'ru' | 'en';
  const userEntries = repo.findByLevel(ctx.user.telegram_id);
  const has = userEntries.some((e) => e.wrong === input.wrong.trim().toLowerCase());
  if (!has) {
    // Check if it's global-only
    const globalEntries = repo.findByLevel(null);
    const isGlobal = globalEntries.some((e) => e.wrong === input.wrong.trim().toLowerCase());
    if (isGlobal) return { success: false, error: t(lang).aiTools.dict.globalOnly };
    return { success: false, error: t(lang).aiTools.dict.notFound };
  }
  repo.delete(ctx.user.telegram_id, input.wrong);
  return { success: true, output: t(lang).aiTools.dict.deleted(input.wrong) };
}

export function handleDictList(_input: Record<never, never>, ctx: AgentContext): ToolResult {
  const repo = ctx.sttCorrectionsRepo;
  if (!repo) return { success: false, error: 'STT corrections not available' };
  const entries = repo.findMerged(ctx.user.telegram_id);
  return { success: true, data: entries, output: entries.length === 0
    ? t(ctx.user.language as 'ru' | 'en').aiTools.dict.listEmpty
    : entries.map((e) => `${e.wrong} → ${e.correct}${e.isGlobal ? ' [global]' : ''}`).join('\n')
  };
}

export function handleDictSearch(input: DictSearchInput, ctx: AgentContext): ToolResult {
  const repo = ctx.sttCorrectionsRepo;
  if (!repo) return { success: false, error: 'STT corrections not available' };
  const lang = ctx.user.language as 'ru' | 'en';
  const corrections = repo.findMerged(ctx.user.telegram_id);
  const results = TranscriptEnricher.search(input.word, corrections);
  if (results.length === 0) return { success: true, output: t(lang).aiTools.dict.searchEmpty(input.word), data: [] };
  return {
    success: true,
    output: t(lang).aiTools.dict.searchResults(input.word, results.length) + '\n' +
      results.map((r) => `  ${r.word} → ${r.candidate} (${r.score.toFixed(2)})`).join('\n'),
    data: results,
  };
}
```

- [ ] **Step 5: Add tool schemas to tools.ts**

Add four tools near the end of the tool definitions array:

```ts
{
  name: 'dict_search_phonetic',
  description: 'Search the STT corrections dictionary for phonetic matches to a given word. Returns top-5 matches with scores.',
  input_schema: {
    type: 'object',
    properties: {
      word: { type: 'string', description: 'Word or phrase to search for phonetic matches' },
    },
    required: ['word'],
  },
},
{
  name: 'dict_add',
  description: 'Add or update a correction in the user\'s personal STT dictionary. Use after confirming with the user what a word should be.',
  input_schema: {
    type: 'object',
    properties: {
      wrong: { type: 'string', description: 'How the word is typically misrecognized by STT' },
      correct: { type: 'string', description: 'The correct form of the word' },
    },
    required: ['wrong', 'correct'],
  },
},
{
  name: 'dict_delete',
  description: 'Remove a correction from the user\'s personal STT dictionary.',
  input_schema: {
    type: 'object',
    properties: {
      wrong: { type: 'string', description: 'The wrong form of the word to remove' },
    },
    required: ['wrong'],
  },
},
{
  name: 'dict_list',
  description: 'List all corrections in the merged dictionary (global + personal) for the current user.',
  input_schema: { type: 'object', properties: {} },
},
```

- [ ] **Step 6: Wire in tool-executor.ts**

Add import:
```ts
import { handleDictAdd, handleDictDelete, handleDictList, handleDictSearch } from './tool-handlers/dict.ts';
```

Add cases to the switch:
```ts
case 'dict_search_phonetic':
  return handleDictSearch(input as { word: string }, ctx);
case 'dict_add':
  return handleDictAdd(input as { wrong: string; correct: string }, ctx);
case 'dict_delete':
  return handleDictDelete(input as { wrong: string }, ctx);
case 'dict_list':
  return handleDictList({}, ctx);
```

After agent turn in `message.handler.ts` (and call-session.ts), handle admin promotion:

```ts
const { responseText } = await deps.agent.run(agentContext);
// Admin promotion keyboard
if (agentContext.sttAdminPromotion && agentContext.sender?.sendMessageWithKeyboard) {
  const { wrong, correct } = agentContext.sttAdminPromotion;
  const keyboard = new InlineKeyboard()
    .text('Да, для всех', `dict_promote:global:${encodeURIComponent(wrong)}:${encodeURIComponent(correct)}`)
    .text('Только для меня', `dict_promote:skip`);
  agentContext.sender.sendMessageWithKeyboard(
    agentContext.chatId,
    'Сохранить это исправление для всех пользователей?',
    keyboard,
  ).catch((err) => botLogger.error({ err }, 'Failed to send admin promotion keyboard'));
}
```

> `callback_data` must stay ≤ 64 bytes. If `wrong + correct > 40 chars`, store the payload server-side and pass a short ID instead.

- [ ] **Step 7: Run tests — confirm they pass**

```bash
bun test test/services/ai/tool-handlers/dict.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-handlers/dict.ts src/services/ai/tool-executor.ts src/config/constants.ts test/services/ai/tool-handlers/dict.test.ts
git commit -m "feat(stt): dict_* AI tools with phonetic search, add/delete/list"
```

---

## Task 8: /dict Bot Command

**Files:**
- Create: `src/bot/commands/dict.ts`
- Modify: `src/bot/index.ts`
- Modify: `src/config/constants.ts` — add MSG strings for /dict UI
- Modify: `src/bot/handlers/callback.handler.ts` — handle dict callbacks via ID store
- Modify: `src/bot/handlers/message.handler.ts` — complete edit flow

> **Callback safety:** All callbacks that carry payload (wrong/correct values) use a short opaque ID looked up from an in-memory `DictCallbackStore`. This solves three problems at once: 64-byte limit, unsafe `:` delimiter splitting, and unbounded payload size.
>
> **Edit flow completion:** After `dict:edit` sends a prompt, `dictEditPending` (Map<userId, { wrong, expiry }>) stores the pending state. The message handler checks this map before normal message routing.

- [ ] **Step 1: Add bot message strings to constants.ts**

Add under `MSG.ru` and `MSG.en` (not in `aiTools` — these are direct bot messages):

```ts
// In MSG.ru:
dict_header: '📖 Твой словарь исправлений',
dict_global_section: (n: number) => `🌐 Общий (${n}):`,
dict_user_section: (n: number) => `👤 Твой (${n}):`,
dict_empty: 'Словарь пуст.',
dict_add_prompt: 'Напиши исправление в формате:\nкак слышится → как правильно',
dict_add_correct_prompt: (correct: string) =>
  `Как бот мог расслышать «${correct}» неправильно? Напиши вариант, который получается — например, «визором». Или нажми пропустить.`,
dict_add_skip_btn: 'Пропустить',
dict_saved: (wrong: string, correct: string) => `✅ Сохранено: «${wrong}» → «${correct}»`,
dict_deleted: (wrong: string) => `🗑 Удалено: «${wrong}»`,
dict_select_to_delete: 'Выбери запись для удаления:',
dict_select_to_edit: 'Выбери запись для изменения:',
dict_edit_prompt: (wrong: string) => `Новое значение для «${wrong}»:`,
dict_global_only_notice: 'Это глобальная запись — только администратор может её изменить.',
dict_admin_promote_prompt: 'Сохранить это исправление для всех пользователей?',
dict_promoted_global: '✅ Сохранено для всех пользователей.',

// In MSG.en: (mirror with English text)
```

- [ ] **Step 2: Create dict command handler with DictCallbackStore**

```ts
// src/bot/commands/dict.ts
import { InlineKeyboard } from 'gramio';
import type { SttCorrectionsRepository } from '../../database/repositories/stt-corrections.repository.ts';
import { t } from '../../config/constants.ts';
import { splitMessage } from '../../utils/telegram.ts';
import type { User } from '../../database/types.ts';

// ---------------------------------------------------------------------------
// Callback ID store — avoids 64-byte limit and colon-parsing issues
// ---------------------------------------------------------------------------

type DictCallbackPayload =
  | { type: 'del'; wrong: string }
  | { type: 'edit'; wrong: string }
  | { type: 'skip'; correct: string }
  | { type: 'promote'; wrong: string; correct: string };

let _seq = 0;
const _store = new Map<string, DictCallbackPayload>();

export function storeDictPayload(payload: DictCallbackPayload): string {
  const id = (++_seq).toString(36); // 'dict:del:1a' is always ≤ 20 bytes
  _store.set(id, payload);
  return id;
}

export function getDictPayload(id: string): DictCallbackPayload | undefined {
  return _store.get(id);
}

// ---------------------------------------------------------------------------
// Pending state — Map<userId, { ... }>
// Two modes: edit (waiting for new correct value) and add (waiting for "wrong → correct")
// ---------------------------------------------------------------------------

const PENDING_TTL_MS = 5 * 60 * 1000;

interface EditPending { mode: 'edit'; wrong: string; expiry: number }
interface AddPending  { mode: 'add';  expiry: number }
type DictPending = EditPending | AddPending;

const _pending = new Map<number, DictPending>();

export function setEditPending(userId: number, wrong: string): void {
  _pending.set(userId, { mode: 'edit', wrong, expiry: Date.now() + PENDING_TTL_MS });
}

export function setAddPending(userId: number): void {
  _pending.set(userId, { mode: 'add', expiry: Date.now() + PENDING_TTL_MS });
}

export function consumePending(userId: number): DictPending | undefined {
  const entry = _pending.get(userId);
  if (!entry) return undefined;
  if (Date.now() > entry.expiry) { _pending.delete(userId); return undefined; }
  _pending.delete(userId);
  return entry;
}

// Keep old name as alias for callers that only deal with edit
export function consumeEditPending(userId: number): string | undefined {
  const p = consumePending(userId);
  return p?.mode === 'edit' ? p.wrong : undefined;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export interface DictCommandDeps {
  sttCorrectionsRepo: SttCorrectionsRepository;
}

export async function handleDictList(
  ctx: { user: User; send: (text: string, opts?: unknown) => Promise<unknown> },
  deps: DictCommandDeps,
): Promise<void> {
  const lang = ctx.user.language as 'ru' | 'en';
  const msgs = t(lang);
  const userId = ctx.user.telegram_id;
  const global_ = deps.sttCorrectionsRepo.findByLevel(null);
  const personal = deps.sttCorrectionsRepo.findByLevel(userId);
  const lines: string[] = [msgs.dict_header];

  if (global_.length > 0) {
    lines.push('');
    lines.push(msgs.dict_global_section(global_.length));
    for (const e of global_) lines.push(`  • ${e.wrong} → ${e.correct}`);
  }
  if (personal.length > 0) {
    lines.push('');
    lines.push(msgs.dict_user_section(personal.length));
    for (const e of personal) lines.push(`  • ${e.wrong} → ${e.correct}`);
  }
  if (global_.length === 0 && personal.length === 0) {
    lines.push('');
    lines.push(msgs.dict_empty);
  }

  const keyboard = new InlineKeyboard()
    .text('+ Добавить', 'dict:add')
    .text('🗑 Удалить', 'dict:del_list')
    .text('✏️ Изменить', 'dict:edit_list');

  const text = lines.join('\n');
  const parts = splitMessage(text);
  for (const part of parts) {
    await ctx.send(part);
  }
  await ctx.send(msgs.dict_header, { reply_markup: keyboard });
}

// /dict <correct>
export async function handleDictAddCorrect(
  correct: string,
  ctx: { user: User; send: (text: string, opts?: unknown) => Promise<unknown> },
): Promise<void> {
  const lang = ctx.user.language as 'ru' | 'en';
  const msgs = t(lang);
  const id = storeDictPayload({ type: 'skip', correct });
  const keyboard = new InlineKeyboard().text(msgs.dict_add_skip_btn, `dict:skip:${id}`);
  await ctx.send(msgs.dict_add_correct_prompt(correct), { reply_markup: keyboard });
}

// /dict <wrong> -> <correct>
export async function handleDictAddDirect(
  wrong: string,
  correct: string,
  ctx: { user: User; send: (text: string, opts?: unknown) => Promise<unknown>; botAdminId?: number },
  deps: DictCommandDeps,
): Promise<void> {
  const lang = ctx.user.language as 'ru' | 'en';
  const msgs = t(lang);
  const userId = ctx.user.telegram_id;
  deps.sttCorrectionsRepo.add(userId, wrong, correct);
  await ctx.send(msgs.dict_saved(wrong, correct));

  if (ctx.botAdminId && userId === ctx.botAdminId) {
    const id = storeDictPayload({ type: 'promote', wrong, correct });
    const keyboard = new InlineKeyboard()
      .text('Да, для всех', `dict:p:${id}`)
      .text('Только для меня', 'dict:pskip');
    await ctx.send(msgs.dict_admin_promote_prompt, { reply_markup: keyboard });
  }
}

// Called from message.handler.ts when user is in edit pending state
export async function completeEditFlow(
  userId: number,
  wrong: string,
  newCorrect: string,
  ctx: { send: (text: string, opts?: unknown) => Promise<unknown>; botAdminId?: number; lang: 'ru' | 'en' },
  deps: DictCommandDeps,
): Promise<void> {
  const msgs = t(ctx.lang);
  deps.sttCorrectionsRepo.add(userId, wrong, newCorrect);
  await ctx.send(msgs.dict_saved(wrong, newCorrect));

  if (ctx.botAdminId && userId === ctx.botAdminId) {
    const id = storeDictPayload({ type: 'promote', wrong, correct: newCorrect });
    const keyboard = new InlineKeyboard()
      .text('Да, для всех', `dict:p:${id}`)
      .text('Только для меня', 'dict:pskip');
    await ctx.send(msgs.dict_admin_promote_prompt, { reply_markup: keyboard });
  }
}
```

- [ ] **Step 3: Register /dict command in bot/index.ts**

```ts
import { handleDictList, handleDictAddCorrect, handleDictAddDirect } from './commands/dict.ts';

bot.command('dict', async (ctx) => {
  const user = ctx.user as User;
  const args = ctx.args?.trim() ?? '';
  const send = (text: string, opts?: unknown) => ctx.send(text, opts as never);

  if (!args) {
    await handleDictList({ user, send }, { sttCorrectionsRepo: db.sttCorrections });
    return;
  }

  // /dict <wrong> -> <correct>
  const arrowMatch = args.match(/^(.+?)\s*->\s*(.+)$/);
  if (arrowMatch) {
    await handleDictAddDirect(
      arrowMatch[1]!.trim(), arrowMatch[2]!.trim(),
      { user, send, botAdminId: config.BOT_ADMIN_ID ? Number(config.BOT_ADMIN_ID) : undefined },
      { sttCorrectionsRepo: db.sttCorrections },
    );
    return;
  }

  // /dict <correct>
  await handleDictAddCorrect(args, { user, send });
});
```

- [ ] **Step 4: Handle callbacks in callback.handler.ts**

All payloads go through `getDictPayload(id)` — no raw values in callback_data, no colon-splitting:

```ts
import { completeEditFlow, consumePending, getDictPayload, setAddPending, setEditPending, storeDictPayload } from '../commands/dict.ts';

// dict:add — show prompt, set add-pending state
if (data === 'dict:add') {
  setAddPending(user.telegram_id);
  await ctx.send(msgs.dict_add_prompt);
  await ctx.answer();
  return;
}

// dict:del_list
if (data === 'dict:del_list') {
  const entries = db.sttCorrections.findByLevel(user.telegram_id);
  if (entries.length === 0) { await ctx.answer(); return; }
  const kb = new InlineKeyboard();
  for (const e of entries.slice(0, 20)) {
    const id = storeDictPayload({ type: 'del', wrong: e.wrong });
    kb.text(`${e.wrong} → ${e.correct}`, `dict:del:${id}`).row();
  }
  await ctx.send(msgs.dict_select_to_delete, { reply_markup: kb });
  await ctx.answer();
  return;
}

// dict:del:<id>
if (data.startsWith('dict:del:')) {
  const payload = getDictPayload(data.slice('dict:del:'.length));
  if (payload?.type === 'del') {
    db.sttCorrections.delete(user.telegram_id, payload.wrong);
    await ctx.send(msgs.dict_deleted(payload.wrong));
  }
  await ctx.answer();
  return;
}

// dict:edit_list
if (data === 'dict:edit_list') {
  const entries = db.sttCorrections.findByLevel(user.telegram_id);
  if (entries.length === 0) { await ctx.answer(); return; }
  const kb = new InlineKeyboard();
  for (const e of entries.slice(0, 20)) {
    const id = storeDictPayload({ type: 'edit', wrong: e.wrong });
    kb.text(`${e.wrong} → ${e.correct}`, `dict:edit:${id}`).row();
  }
  await ctx.send(msgs.dict_select_to_edit, { reply_markup: kb });
  await ctx.answer();
  return;
}

// dict:edit:<id> — store pending state, send prompt
if (data.startsWith('dict:edit:')) {
  const payload = getDictPayload(data.slice('dict:edit:'.length));
  if (payload?.type === 'edit') {
    setEditPending(user.telegram_id, payload.wrong);
    await ctx.send(msgs.dict_edit_prompt(payload.wrong));
  }
  await ctx.answer();
  return;
}

// dict:skip:<id> — save wrong=correct (hint-only)
if (data.startsWith('dict:skip:')) {
  const payload = getDictPayload(data.slice('dict:skip:'.length));
  if (payload?.type === 'skip') {
    db.sttCorrections.add(user.telegram_id, payload.correct, payload.correct);
    await ctx.send(msgs.dict_saved(payload.correct, payload.correct));
  }
  await ctx.answer();
  return;
}

// dict:p:<id> — admin promote to global
if (data.startsWith('dict:p:')) {
  const payload = getDictPayload(data.slice('dict:p:'.length));
  if (payload?.type === 'promote') {
    db.sttCorrections.add(null, payload.wrong, payload.correct);
    await ctx.send(msgs.dict_promoted_global);
  }
  await ctx.answer();
  return;
}

if (data === 'dict:pskip') {
  await ctx.answer();
  return;
}
```

- [ ] **Step 5: Wire pending dict state in message.handler.ts**

At the top of the text message handler (before normal routing):

```ts
import { completeEditFlow, consumePending, handleDictAddCorrect, handleDictAddDirect } from '../commands/dict.ts';

// In message handler, before normal pipeline — check dict pending state:
if (messageText && deps.sttCorrectionsRepo) {
  const pending = consumePending(user.telegram_id);
  if (pending) {
    const send = (text: string, opts?: unknown) => ctx.send(text, opts as never);
    const lang = user.language as 'ru' | 'en';
    const botAdminId = deps.botAdminId;
    const dictDeps = { sttCorrectionsRepo: deps.sttCorrectionsRepo };

    if (pending.mode === 'edit') {
      // User typed new correct value for pending.wrong
      await completeEditFlow(user.telegram_id, pending.wrong, messageText, { send, botAdminId, lang }, dictDeps);
    } else {
      // pending.mode === 'add': parse "wrong → correct" or treat as correct-only
      const arrowMatch = messageText.match(/^(.+?)\s*(?:->|→)\s*(.+)$/);
      if (arrowMatch) {
        await handleDictAddDirect(
          arrowMatch[1]!.trim(), arrowMatch[2]!.trim(),
          { user, send, botAdminId },
          dictDeps,
        );
      } else {
        // Single word: ask for the wrong form (same as /dict <correct>)
        await handleDictAddCorrect(messageText.trim(), { user, send });
      }
    }
    return; // consumed — skip normal pipeline
  }
}
```

Also add `botAdminId?: number` to `MessageHandlerDeps` and pass `Number(config.BOT_ADMIN_ID)` when constructing deps.

- [ ] **Step 6: Wire admin promotion after dict_add AI tool**

In `message.handler.ts` after `deps.agent.run(agentContext)`:

```ts
if (agentContext.sttAdminPromotion && agentContext.sender?.sendMessageWithKeyboard) {
  const { wrong, correct } = agentContext.sttAdminPromotion;
  const id = storeDictPayload({ type: 'promote', wrong, correct });
  const keyboard = new InlineKeyboard()
    .text('Да, для всех', `dict:p:${id}`)
    .text('Только для меня', 'dict:pskip');
  agentContext.sender.sendMessageWithKeyboard(
    agentContext.chatId,
    t(agentContext.user.language as 'ru' | 'en').dict_admin_promote_prompt,
    keyboard,
  ).catch((err) => botLogger.error({ err }, 'Failed to send admin promotion keyboard'));
}
```

Same block goes in `call-session.ts` `runAgent()` after `this.cfg.agent.run(ctx)`.

- [ ] **Step 7: Write tests for dict.ts pending state and message handler integration**

Two test files:

**`test/bot/commands/dict.test.ts`** — unit tests for pending state and handlers:

```ts
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  completeEditFlow,
  consumePending,
  getDictPayload,
  handleDictAddCorrect,
  handleDictAddDirect,
  handleDictList,
  setAddPending,
  setEditPending,
  storeDictPayload,
} from '../../../src/bot/commands/dict.ts';
import { SttCorrectionsRepository } from '../../../src/database/repositories/stt-corrections.repository.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { User } from '../../../src/database/types.ts';

function makeDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function makeUser(id = 1): User {
  return { telegram_id: id, language: 'ru' } as User;
}

describe('DictCallbackStore', () => {
  test('storeDictPayload + getDictPayload round-trips payload', () => {
    const id = storeDictPayload({ type: 'del', wrong: 'визором' });
    expect(id.length).toBeLessThanOrEqual(10); // always short
    expect(getDictPayload(id)).toMatchObject({ type: 'del', wrong: 'визором' });
  });

  test('callback ID fits within 64-byte limit for all types', () => {
    const payloads = [
      { type: 'del' as const, wrong: 'предположительно' },
      { type: 'edit' as const, wrong: 'предположительно' },
      { type: 'skip' as const, correct: 'очень длинное исправление которое не влезет' },
      { type: 'promote' as const, wrong: 'длинное слово', correct: 'другое длинное слово' },
    ] satisfies Parameters<typeof storeDictPayload>[0][];

    for (const payload of payloads) {
      const id = storeDictPayload(payload);
      const prefix = payload.type === 'del' ? 'dict:del:' :
                     payload.type === 'edit' ? 'dict:edit:' :
                     payload.type === 'skip' ? 'dict:skip:' : 'dict:p:';
      const callbackData = `${prefix}${id}`;
      expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});

describe('pending state', () => {
  test('consumePending returns undefined when nothing pending', () => {
    expect(consumePending(9999)).toBeUndefined();
  });

  test('setAddPending + consumePending returns add entry', () => {
    setAddPending(1);
    const p = consumePending(1);
    expect(p?.mode).toBe('add');
  });

  test('setEditPending + consumePending returns edit entry with wrong', () => {
    setEditPending(2, 'визором');
    const p = consumePending(2);
    expect(p?.mode).toBe('edit');
    if (p?.mode === 'edit') expect(p.wrong).toBe('визором');
  });

  test('consumePending removes the entry (one-shot)', () => {
    setAddPending(3);
    consumePending(3);
    expect(consumePending(3)).toBeUndefined();
  });

  test('edit pending expires after TTL', () => {
    const original = Date.now;
    try {
      setEditPending(4, 'тест');
      Date.now = () => original() + 6 * 60 * 1000; // 6 min later
      expect(consumePending(4)).toBeUndefined();
    } finally {
      Date.now = original;
    }
  });
});

describe('handleDictAddDirect', () => {
  let db: Database;
  let repo: SttCorrectionsRepository;

  beforeEach(() => { db = makeDb(); repo = new SttCorrectionsRepository(db); });
  afterEach(() => db.close());

  test('saves entry and confirms', async () => {
    const sent: string[] = [];
    const send = mock((text: string) => { sent.push(text); return Promise.resolve(); });
    await handleDictAddDirect('питер', 'Санкт-Петербург', { user: makeUser(1), send }, { sttCorrectionsRepo: repo });
    expect(repo.findMerged(1)).toHaveLength(1);
    expect(sent[0]).toContain('Сохранено');
  });

  test('shows admin promotion keyboard when user is admin', async () => {
    const keyboards: unknown[] = [];
    const send = mock((_, opts?: unknown) => { if (opts) keyboards.push(opts); return Promise.resolve(); });
    await handleDictAddDirect(
      'питер', 'Санкт-Петербург',
      { user: makeUser(42), send, botAdminId: 42 },
      { sttCorrectionsRepo: repo },
    );
    expect(keyboards.length).toBe(1);
  });

  test('no admin keyboard for non-admin user', async () => {
    const keyboards: unknown[] = [];
    const send = mock((_, opts?: unknown) => { if (opts) keyboards.push(opts); return Promise.resolve(); });
    await handleDictAddDirect(
      'питер', 'Санкт-Петербург',
      { user: makeUser(1), send, botAdminId: 99 },
      { sttCorrectionsRepo: repo },
    );
    expect(keyboards.length).toBe(0);
  });
});

describe('handleDictAddCorrect', () => {
  test('sends prompt with skip button', async () => {
    const sent: string[] = [];
    const keyboards: unknown[] = [];
    const send = mock((text: string, opts?: unknown) => {
      sent.push(text);
      if (opts) keyboards.push(opts);
      return Promise.resolve();
    });
    await handleDictAddCorrect('виза-ран', { user: makeUser(), send });
    expect(sent[0]).toContain('виза-ран');
    expect(keyboards.length).toBe(1);
  });
});

describe('completeEditFlow', () => {
  let db: Database;
  let repo: SttCorrectionsRepository;

  beforeEach(() => { db = makeDb(); repo = new SttCorrectionsRepository(db); });
  afterEach(() => db.close());

  test('saves new correct value', async () => {
    const send = mock(() => Promise.resolve());
    repo.add(1, 'питер', 'старое');
    await completeEditFlow(1, 'питер', 'Санкт-Петербург', { send, lang: 'ru' }, { sttCorrectionsRepo: repo });
    expect(repo.findMerged(1)[0]?.correct).toBe('санкт-петербург');
  });
});

describe('handleDictList', () => {
  let db: Database;
  let repo: SttCorrectionsRepository;

  beforeEach(() => { db = makeDb(); repo = new SttCorrectionsRepository(db); });
  afterEach(() => db.close());

  test('shows empty message when dictionary is empty', async () => {
    const sent: string[] = [];
    const send = mock((text: string) => { sent.push(text); return Promise.resolve(); });
    await handleDictList({ user: makeUser(), send }, { sttCorrectionsRepo: repo });
    expect(sent.some((s) => s.includes('пуст'))).toBe(true);
  });

  test('shows global and personal sections', async () => {
    repo.add(null, 'один', 'one');
    repo.add(1, 'два', 'two');
    const sent: string[] = [];
    const send = mock((text: string) => { sent.push(text); return Promise.resolve(); });
    await handleDictList({ user: makeUser(), send }, { sttCorrectionsRepo: repo });
    const all = sent.join('\n');
    expect(all).toContain('Общий');
    expect(all).toContain('Твой');
  });
});
```

**Additions to `test/bot/handlers/message.handler.test.ts`** — pending state integration:

```ts
// Add these tests inside the existing describe('createMessageHandler') block.
// They need sttCorrectionsRepo in deps and dictEditPending/setAddPending imported.
import { setAddPending, setEditPending } from '../../../src/bot/commands/dict.ts';
import { Database } from 'bun:sqlite';
import { SttCorrectionsRepository } from '../../../src/database/repositories/stt-corrections.repository.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function makeRepoDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return { db, repo: new SttCorrectionsRepository(db) };
}

test('dict add pending: arrow format saves entry without calling agent', async () => {
  const { db, repo } = makeRepoDb();
  const deps = makeDeps({ sttCorrectionsRepo: repo });
  const handler = createMessageHandler(deps as never);
  setAddPending(100); // user 100 has add pending
  await handler(makeCtx({ text: 'питер → Санкт-Петербург' }) as never);
  expect(deps.agent.run).not.toHaveBeenCalled();
  expect(repo.findMerged(100)).toHaveLength(1);
  db.close();
});

test('dict add pending: single word prompts for wrong form, skips agent', async () => {
  const { db, repo } = makeRepoDb();
  const sent: string[] = [];
  const deps = makeDeps({ sttCorrectionsRepo: repo });
  const handler = createMessageHandler(deps as never);
  setAddPending(100);
  await handler(makeCtx({ send: mock((t: string) => { sent.push(t); return Promise.resolve(); }), text: 'виза-ран' }) as never);
  expect(deps.agent.run).not.toHaveBeenCalled();
  // handleDictAddCorrect sends a prompt containing the word
  expect(sent.some((s) => s.includes('виза-ран'))).toBe(true);
  db.close();
});

test('dict edit pending: saves new value without calling agent', async () => {
  const { db, repo } = makeRepoDb();
  repo.add(100, 'питер', 'старое');
  const deps = makeDeps({ sttCorrectionsRepo: repo });
  const handler = createMessageHandler(deps as never);
  setEditPending(100, 'питер');
  await handler(makeCtx({ text: 'Санкт-Петербург' }) as never);
  expect(deps.agent.run).not.toHaveBeenCalled();
  expect(repo.findMerged(100)[0]?.correct).toBe('санкт-петербург');
  db.close();
});

test('no pending state: message routes normally to agent', async () => {
  const { db, repo } = makeRepoDb();
  const deps = makeDeps({ sttCorrectionsRepo: repo });
  const handler = createMessageHandler(deps as never);
  // no setAddPending / setEditPending called
  await handler(makeCtx({ text: 'обычное сообщение' }) as never);
  expect(deps.agent.run).toHaveBeenCalledTimes(1);
  db.close();
});
```

- [ ] **Step 8: Run tests — confirm they pass**

```bash
bun test test/bot/commands/dict.test.ts test/bot/handlers/message.handler.test.ts
```
Expected: all pass. Fix any issues with imports or missing exports before committing.

- [ ] **Step 9: Run all tests**

```bash
bun test
bun run lint
```
Fix any lint warnings before committing.

- [ ] **Step 8: Commit**

```bash
git add src/bot/commands/dict.ts src/bot/index.ts src/bot/handlers/callback.handler.ts src/bot/handlers/message.handler.ts src/config/constants.ts
git commit -m "feat(stt): /dict bot command with safe ID-based callbacks, edit flow, admin promotion"
```

---

## Final Verification

- [ ] Run full test suite and confirm green:
```bash
bun test --coverage
```
Expected: ≥ 93% line coverage, 0 failures.

- [ ] Run linter:
```bash
bun run lint
```
Expected: 0 warnings, 0 errors.

- [ ] Manual smoke test (if bot is running):
  1. `/dict` — see empty dictionary
  2. `/dict Санкт-Петербург` — bot asks for wrong form
  3. `/dict питер -> Санкт-Петербург` — saves directly
  4. `/dict` — entry appears in "Твой" section
  5. Send voice message saying "питер" — agent should see correction candidate in sttMeta

# Spec 10: STT Corrections Dictionary

## Overview

A per-user and global corrections dictionary for STT post-processing. After Deepgram returns a transcript, the system annotates it with phonetically matched correction candidates and low-confidence word scores before passing it to the main AI agent. The agent has tools to manage the dictionary and can ask the user to clarify uncertain words during conversation.

No AI (Haiku) is involved in the correction pipeline — everything is algorithmic.

---

## Dictionary

### Storage

SQLite table `stt_corrections`:

```sql
CREATE TABLE stt_corrections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(telegram_id) ON DELETE CASCADE,
  wrong       TEXT NOT NULL,
  correct     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- COALESCE handles NULL user_id: SQLite treats NULL != NULL in unique indexes
CREATE UNIQUE INDEX stt_corrections_unique ON stt_corrections(COALESCE(user_id, -1), wrong);
CREATE INDEX stt_corrections_user ON stt_corrections(user_id);
```

`user_id IS NULL` = global entry (visible to all users). Per-user entries override global entries with the same `wrong` key.

> **SQLite NULL caveat:** a standard `UNIQUE(user_id, wrong)` index does NOT prevent duplicate global rows because `NULL != NULL` in SQL-92. The `COALESCE(user_id, -1)` index expression treats all global rows as `user_id = -1` for uniqueness purposes. `-1` is safe because `telegram_id` values are always positive.

### Repository: `SttCorrectionsRepository`

- `add(userId: number | null, wrong: string, correct: string): void` — upserts with `ON CONFLICT DO UPDATE SET correct = excluded.correct, created_at = datetime('now')`; normalizes both `wrong` and `correct` to lowercase-trimmed before storing
- `delete(userId: number | null, wrong: string): void`
- `findMerged(userId: number): Array<{ wrong: string; correct: string; isGlobal: boolean }>` — global + user entries merged; per-user entry wins on conflict with same `wrong`
- `findByLevel(userId: number | null): Array<{ wrong: string; correct: string }>` — entries for one level only

**Normalization at save time:** `wrong` and `correct` are stored as lowercase-trimmed strings. This prevents "Визором" and "визором" from creating separate entries.

---

## Changes to STT Classes

### `NovaStreamingSTT` (Russian, streaming)

Extend `NovaStreamingSTTEvents`:

```ts
interface NovaStreamingSTTEvents {
  onInterim: (transcript: string) => void;
  onFinal: (transcript: string, words?: Array<{ word: string; confidence: number }>) => void;
  onError: (err: Error) => void;
}
```

In the `onmessage` handler, parse `channel.alternatives[0].words` from the Deepgram response (already present in Nova-3 JSON) and pass it to `onFinal`.

### `FluxStreamingSTT` (English, streaming)

Extend `FluxStreamingSTTEvents`:

```ts
interface FluxStreamingSTTEvents {
  onStartOfTurn: () => void;
  onEndOfTurn: (confidence: number, transcript: string, words?: Array<{ word: string; confidence: number }>) => void;
  onInterim: (transcript: string) => void;
  onError: (err: Error) => void;
}
```

Parse `words[]` from the `TurnInfo` / `EndOfTurn` Deepgram v2 response if present.

Both `words` parameters are optional — the enricher handles their absence gracefully (no inline confidence annotations, only dictionary matching).

---

## TranscriptEnricher

New service: `src/services/voice/transcript-enricher.ts`

### Phonetic Normalization

Applied to both sides before any comparison:

```
ё → е
й → и
ъ, ь → "" (removed)
double consonants → single
word-final devoicing: б→п, в→ф, г→к, д→т, ж→ш, з→с
```

### Algorithm Selection by Word Length

| Word length (normalized) | Algorithm | Match threshold |
|---|---|---|
| ≤ 6 chars | Levenshtein distance | `≤ floor(len / 2)` |
| > 6 chars | Trigram Jaccard similarity | `≥ 0.45` |

Both algorithms operate on phonetically normalized forms. The threshold is intentionally permissive because results are hints to the agent, not auto-replacements.

For multi-word `wrong` entries, the enricher checks transcript n-grams of the same token count.

When multiple candidates match a word, return top-3 sorted by score descending. `dict_search_phonetic` tool returns top-5 (more candidates are useful when the agent is actively searching).

Entries where `wrong == correct` (saved via `/dict <correct>` + skip) are excluded from the `corrections` output — they exist only as hints for `dict_search_phonetic` and do not produce replacement candidates.

### Input

```ts
interface EnrichInput {
  transcript: string;
  words?: Array<{ word: string; confidence: number }>; // per-word from Deepgram; absent for Whisper
  corrections: Array<{ wrong: string; correct: string }>;
}
```

### Output: `EnrichedTranscript`

```ts
interface EnrichedTranscript {
  // Text for the agent's messageText field.
  // Low-confidence words annotated inline: "визором[0.41]"
  annotated: string;

  // Phonetic match candidates from dictionary
  corrections: Array<{
    word: string;       // as it appeared in transcript
    candidate: string;  // correct value from dictionary
    score: number;      // normalized similarity 0..1
  }>;

  // Words below confidence threshold (< 0.6), for agent awareness
  lowConfidence: Array<{
    word: string;
    confidence: number;
  }>;
}
```

Confidence threshold for inline annotation: `< 0.6`.

---

## AgentContext Changes

Add optional field to `AgentContext` (`src/services/ai/types.ts`):

```ts
interface SttMeta {
  corrections: Array<{ word: string; candidate: string; score: number }>;
  lowConfidence: Array<{ word: string; confidence: number }>;
}

// In AgentContext:
sttMeta?: SttMeta;
```

---

## Integration Points

### Live calls (`CallSession`)

1. Add `sttCorrectionsRepo: SttCorrectionsRepository` to `CallSessionConfig`.
2. Add private field `private lastWords: Array<{ word: string; confidence: number }> | undefined` to `CallSession`. Reset to `undefined` in `onVadStart()` (Nova) and on `onStartOfTurn` (Flux). Populated from the `words` argument of `onFinal` (Nova) and `onEndOfTurn` (Flux) callbacks.
3. In `onEnoughToRespond()`, before calling `runAgent()`:
   - Load `corrections = sttCorrectionsRepo.findMerged(userId)`
   - Call `TranscriptEnricher.enrich({ transcript: rollingTranscript, words: this.lastWords, corrections })`
   - Pass `annotated` as `messageText`, attach `EnrichedTranscript.corrections` and `lowConfidence` to `AgentContext.sttMeta`
4. When `onEnoughToRespond()` fires from an interim result (interrupt path via `classifyInterrupt`), `lastWords` may be `undefined` — expected. Confidence annotations are skipped; dictionary matching still runs.

### Whisper batch (`TranscriptionService`)

`TranscriptionService.transcribe()` signature is unchanged — returns `Promise<string>`. The caller (bot voice message handler) runs the transcript through `TranscriptEnricher.enrich({ transcript, corrections })` with no `words` (no per-word confidence). Result: `annotated` = original transcript (no brackets), `corrections` as normal, `lowConfidence = []`.

---

## Bot Commands

### `/dict` (no args)

Shows the merged dictionary with two sections and action buttons:

```
📖 Твой словарь исправлений

🌐 Общий (N):
  • визором → виза-ран
  • ...

👤 Твой (N):
  • питер → Санкт-Петербург
  • ...

[+ Добавить]  [🗑 Удалить]  [✏️ Изменить]
```

If a section is empty, it is omitted. If total output exceeds 4096 chars, use `splitMessage()` from `src/utils/telegram.ts`.

**Button behavior (callback queries):**
- `[+ Добавить]` — bot sends message "Напиши исправление в формате: как слышится → как правильно", waits for next text message
- `[🗑 Удалить]` — bot shows a list of user's personal entries as inline buttons; tapping one deletes it with confirmation
- `[✏️ Изменить]` — bot shows a list of user's personal entries as inline buttons; tapping one asks for new `correct` value

Global entries shown in `🌐 Общий` are read-only for regular users (no delete/edit buttons for them). Admin can edit them via the same flow.

### `/dict <correct>`

Adds a word/phrase the user wants to be recognized correctly. Bot replies:

> "Как бот мог расслышать «виза-ран» неправильно? Напиши вариант, который получается — например, «визором». Или нажми пропустить."

Button: `[Пропустить]` — saves entry with `wrong = correct` (acts as a hint for `dict_search_phonetic` only; no replacement is applied during enrichment).

### `/dict <wrong> -> <correct>`

Saves the correction directly without questions.

### Admin promotion

After any correction is saved (via `/dict` command or UI buttons), if the acting user is `BOT_ADMIN_ID`, bot sends a follow-up message:

> "Сохранить это исправление для всех пользователей?"

Inline buttons: `[Да, для всех]` / `[Только для меня]`

If "для всех" — entry is saved/updated with `user_id = NULL`.

When saved via the AI `dict_add` tool, the tool's `ToolResult` includes a `pendingAdminPromotion: true` flag. The tool executor sends the inline keyboard as a separate Telegram message **after** the agent turn completes (not mid-stream), to avoid interleaving with the agent's response.

---

## AI Agent Tools

Four new tools in the agent's tool set:

### `dict_search_phonetic`

**Input:** `{ word: string }`
**Action:** Runs phonetic normalization + Levenshtein/Jaccard against the merged dictionary for the current user. Returns top-5 matches with scores.
**Use case:** Agent sees "визором" in annotated transcript and wants to check if it's a known wrong form.

### `dict_add`

**Input:** `{ wrong: string; correct: string }`
**Action:** Adds entry to the user's personal dictionary. If user is admin, triggers the "apply to all?" inline keyboard prompt.
**Use case:** Agent has confirmed with the user what a word should be and wants to remember it.

### `dict_delete`

**Input:** `{ wrong: string }`
**Action:** Removes entry from the user's personal dictionary. Returns an error message if the entry is global (cannot be deleted by non-admin). Returns a not-found message if the entry does not exist in the user's personal dictionary.

### `dict_list`

**Input:** none
**Action:** Returns merged dictionary (global + personal) with `isGlobal` flag per entry.

---

## System Prompt Addition

When `AgentContext.sttMeta` has non-empty `corrections` or `lowConfidence`, the system prompt includes:

```
STT metadata for this turn:
- Possible corrections: визором → виза-ран (score 0.71)
- Low-confidence words: [визором: 0.41]

If any of these words seem relevant, consider asking the user to confirm
what they meant. Use dict_add to save confirmed corrections.
```

---

## What's Out of Scope

- Auto-replacement without agent involvement — the agent always decides whether to apply a correction
- Haiku or any secondary AI model in the correction pipeline
- Exporting/importing dictionaries
- Per-language dictionaries (single table, language-agnostic)

import { z } from 'zod';
import type { Intent } from '../../database/types.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { type CanonicalText, canonicalize, repairTypos } from './canonical-input.ts';
import { parseFilterChain } from './filter-parser.ts';
import { normalize, normalizeWithOffsets, tokenize } from './normalizer.ts';

const StringArrayCodec = jsonCodec(z.array(z.string()));
export interface MatchResult {
  intentId: number;
  captures: Record<string, string>;
}
export type MatchDecision =
  | { kind: 'matched'; strategy: 'exact' | 'pattern'; result: MatchResult }
  | { kind: 'abstain'; reason: 'no_match' | 'ambiguous' | 'missing_capture' | 'input_too_long'; candidates: number[] };
interface IntentEntry {
  intentId: number;
  pattern?: RegExp;
  required: string[];
  parameterized: boolean;
  strictStructure: boolean;
}

const MAX_INPUT_CHARS = 16000;
const MAX_WORKFLOW_NODES = 4096;
const MAX_WORKFLOW_CHARS = 65536;
interface MatchInput {
  raw: string;
  normalized: () => NormalizedText;
  /** Folded, de-noised text for strict rules; the second pass reads the typo-repaired one. */
  canonical: () => CanonicalText;
  repaired: () => CanonicalText | null;
}
type Pass = 'plain' | 'repaired';
interface NormalizedText {
  text: string;
  spans: { start: number; end: number }[];
}

function captureRequirements(workflow: string): { required: string[]; parameterized: boolean } | null {
  if (workflow.length > MAX_WORKFLOW_CHARS) return null;
  const required = new Set<string>();
  let parameterized = false;
  let root: unknown;
  try {
    root = JSON.parse(workflow);
  } catch {
    root = workflow;
  }
  const pending: unknown[] = [root];
  for (let visited = 0; pending.length && visited < MAX_WORKFLOW_NODES; visited++) {
    const value = pending.pop();
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{\s*(\$\d+)\s*(?:\|([^}]*))?\}\}/g)) {
        parameterized = true;
        let hasDefault = false;
        if (match[2]) {
          try {
            hasDefault = parseFilterChain(match[2]).some(
              (filter) => filter.name === 'default' && filter.args.length === 1,
            );
          } catch {
            /* Invalid filters do not relax capture requirements. */
          }
        }
        if (!hasDefault) required.add(match[1]!);
      }
    } else if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
  return pending.length ? null : { required: [...required], parameterized };
}

function rebuildCapture(canon: CanonicalText, raw: string, from: number, to: number): string {
  let out = '';
  for (let i = from; i < to; i++) {
    const span = canon.spans[i];
    if (canon.replaced?.[i]) out += canon.text[i] ?? '';
    else if (span) out += raw.slice(span.start, span.end);
  }
  return out;
}

function extract(entry: IntentEntry, input: MatchInput, pass: Pass = 'plain'): MatchResult | null {
  if (!entry.pattern) return entry.parameterized ? null : { intentId: entry.intentId, captures: {} };
  const raw = input.raw;
  // Strict rules match the canonical text and read every capture back from the raw message.
  // The plain pass is the whole message; the repaired pass runs only for rules that did not match it.
  const strictText = entry.strictStructure ? (pass === 'plain' ? input.canonical() : input.repaired()) : null;
  if (entry.strictStructure && !strictText) return null;
  let match = entry.pattern.exec(strictText ? strictText.text : raw);
  let offsets: NormalizedText | undefined = strictText ?? undefined;
  const covers = (text: string) => match !== null && match.index === 0 && match[0].length === text.length;
  if (!covers(strictText ? strictText.text : raw)) {
    if (entry.strictStructure) return null;
    offsets = input.normalized();
    match = entry.pattern.exec(offsets.text);
    if (!covers(offsets.text)) return null;
  }
  if (!match) return null;
  const captures: Record<string, string> = {};
  for (let i = 1; i < match.length; i++) {
    if (match[i] === undefined) continue;
    const range = match.indices?.[i];
    if (!offsets) captures[`$${i}`] = match[i]!;
    else if (range && range[1] > range[0]) {
      const first = offsets.spans[range[0]],
        last = offsets.spans[range[1] - 1];
      if (first && last)
        // After a typo repair the binding reads the repaired words ("завтро" → "завтра"); the rest stays as typed.
        captures[`$${i}`] =
          strictText?.replaced && pass === 'repaired'
            ? rebuildCapture(strictText, raw, range[0], range[1])
            : raw.slice(first.start, last.end);
    } else captures[`$${i}`] = '';
  }
  return entry.required.some((key) => captures[key] === undefined || captures[key] === '')
    ? null
    : { intentId: entry.intentId, captures };
}

export class IntentMatcher {
  constructor(private readonly mapInput: typeof normalizeWithOffsets = normalizeWithOffsets) {}
  private phraseMap = new Map<string, IntentEntry[]>();
  private triggerIndex = new Map<string, IntentEntry[]>();

  /** Index only approved rules. Oversized or uninspectable slot requirements fail closed. */
  load(intents: Intent[]): void {
    this.phraseMap.clear();
    this.triggerIndex.clear();
    for (const intent of intents) {
      if (intent.status !== 'approved') continue;
      const requirements = captureRequirements(intent.workflow);
      if (!requirements) {
        cmdLogger.warn({ intentId: intent.id }, 'Intent workflow exceeds inspection bound; not indexed');
        continue;
      }
      const entry: IntentEntry = {
        intentId: intent.id,
        ...requirements,
        strictStructure: intent.canonical_name.startsWith('basis.'),
      };
      if (intent.pattern) {
        try {
          entry.pattern = new RegExp(intent.pattern, 'di');
        } catch {
          cmdLogger.warn({ intentId: intent.id }, 'Intent pattern is invalid; argument extraction unavailable');
        }
      }
      const phrases = StringArrayCodec.safeParse(intent.phrases);
      if (!phrases.success) cmdLogger.error({ intentId: intent.id }, 'Intent has invalid phrases JSON');
      else
        for (const key of new Set(phrases.data.map(normalize))) {
          if (!key) continue;
          const rows = this.phraseMap.get(key) ?? [];
          rows.push(entry);
          this.phraseMap.set(key, rows);
        }
      const triggers = StringArrayCodec.safeParse(intent.trigger_words);
      if (!triggers.success) {
        cmdLogger.error({ intentId: intent.id }, 'Intent has invalid trigger_words JSON');
        continue;
      }
      if (entry.pattern)
        for (const key of new Set(triggers.data.map(normalize))) {
          if (!key) continue;
          const rows = this.triggerIndex.get(key) ?? [];
          rows.push(entry);
          this.triggerIndex.set(key, rows);
        }
    }
  }

  /** Compatible convenience API. Ambiguity is not permission to choose the first write. */
  match(text: string): MatchResult | null {
    const decision = this.explain(text);
    return decision.kind === 'matched' ? decision.result : null;
  }

  /** Deterministic selection diagnostics; no generated confidence score or execution side effect. */
  explain(text: string): MatchDecision {
    if (text.length > MAX_INPUT_CHARS) return { kind: 'abstain', reason: 'input_too_long', candidates: [] };
    let normalizedInput: NormalizedText | undefined;
    let canonicalInput: CanonicalText | undefined;
    let repairedInput: { value: CanonicalText | null } | undefined;
    const raw = text.trim();
    const input: MatchInput = {
      raw,
      normalized: () => (normalizedInput ??= this.mapInput(raw)),
      canonical: () => (canonicalInput ??= canonicalize(raw)),
      repaired: () => {
        repairedInput ??= { value: repairTypos(input.canonical()) };
        return repairedInput.value;
      },
    };
    const exact = this.phraseMap.get(normalize(text));
    if (exact?.length) {
      if (exact.length !== 1)
        return { kind: 'abstain', reason: 'ambiguous', candidates: exact.map((e) => e.intentId).sort((a, b) => a - b) };
      const entry = exact[0]!;
      const result =
        entry.parameterized || entry.strictStructure
          ? extract(entry, input)
          : { intentId: entry.intentId, captures: {} };
      return result
        ? { kind: 'matched', strategy: 'exact', result }
        : { kind: 'abstain', reason: 'missing_capture', candidates: [entry.intentId] };
    }
    const candidates = new Map<number, IntentEntry>();
    for (const word of tokenize(text))
      for (const entry of this.triggerIndex.get(word) ?? []) candidates.set(entry.intentId, entry);
    const gather = (pass: Pass, pool: Map<number, IntentEntry>): MatchResult[] => {
      const found: MatchResult[] = [];
      for (const entry of pool.values()) {
        const result = extract(entry, input, pass);
        if (result) found.push(result);
      }
      return found;
    };
    let results = gather('plain', candidates);
    if (results.length === 0) {
      // Nothing matched the message as written: retry once with the command words' single-letter typos repaired.
      const repaired = input.repaired();
      if (repaired) {
        for (const word of tokenize(repaired.text))
          for (const entry of this.triggerIndex.get(word) ?? []) candidates.set(entry.intentId, entry);
        results = gather('repaired', candidates);
      }
    }
    if (results.length === 1) return { kind: 'matched', strategy: 'pattern', result: results[0]! };
    return {
      kind: 'abstain',
      reason: results.length ? 'ambiguous' : 'no_match',
      candidates: results.map((r) => r.intentId).sort((a, b) => a - b),
    };
  }
}

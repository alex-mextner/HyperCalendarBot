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

/** A `{{$n|default(x)}}` reference with an explicit one-argument default does not require a capture. */
function hasDefaultFilter(filterExpr: string | undefined): boolean {
  if (!filterExpr) return false;
  try {
    return parseFilterChain(filterExpr).some((filter) => filter.name === 'default' && filter.args.length === 1);
  } catch {
    /* Invalid filters do not relax capture requirements. */
    return false;
  }
}

/** Adds each `{{$n}}` reference in `value` to `required` (unless defaulted); true when the string has any. */
function collectCaptureReferences(value: string, required: Set<string>): boolean {
  let found = false;
  for (const match of value.matchAll(/\{\{\s*(\$\d+)\s*(?:\|([^}]*))?\}\}/g)) {
    found = true;
    if (!hasDefaultFilter(match[2])) required.add(match[1]!);
  }
  return found;
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
      if (collectCaptureReferences(value, required)) parameterized = true;
    } else if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
  return pending.length ? null : { required: [...required], parameterized };
}

/** The match only when it spans the whole text. */
function wholeTextMatch(pattern: RegExp, text: string): RegExpExecArray | null {
  const match = pattern.exec(text);
  return match && match.index === 0 && match[0].length === text.length ? match : null;
}

/**
 * Capture group `i` as the user typed it. With `offsets` the match ran on normalized text, so the
 * group is mapped back to the raw span (or, after a typo repair, rebuilt from the repaired words); `undefined`
 * when the mapping is unavailable.
 */
function captureAt(
  match: RegExpExecArray,
  i: number,
  raw: string,
  offsets: NormalizedText | undefined,
  repaired: CanonicalText | null,
): string | undefined {
  if (!offsets) return match[i]!;
  const range = match.indices?.[i];
  if (!range || range[1] <= range[0]) return '';
  const first = offsets.spans[range[0]],
    last = offsets.spans[range[1] - 1];
  if (!first || !last) return undefined;
  return repaired?.replaced ? rebuildCapture(repaired, raw, range[0], range[1]) : raw.slice(first.start, last.end);
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

function collectCaptures(
  match: RegExpExecArray,
  raw: string,
  offsets: NormalizedText | undefined,
  repaired: CanonicalText | null,
): Record<string, string> {
  const captures: Record<string, string> = {};
  for (let i = 1; i < match.length; i++) {
    if (match[i] === undefined) continue;
    // After a typo repair the binding reads the repaired words ("завтро" → "завтра"); the rest stays as typed.
    const value = captureAt(match, i, raw, offsets, repaired);
    if (value !== undefined) captures[`$${i}`] = value;
  }
  return captures;
}

function captureResult(
  entry: IntentEntry,
  match: RegExpExecArray,
  raw: string,
  offsets: NormalizedText | undefined,
  repaired: CanonicalText | null,
): MatchResult | null {
  const captures = collectCaptures(match, raw, offsets, repaired);
  return entry.required.some((key) => captures[key] === undefined || captures[key] === '')
    ? null
    : { intentId: entry.intentId, captures };
}

/**
 * Strict rules match the canonical text and read every capture back from the raw message.
 * The plain pass is the whole message; the repaired pass runs only for rules that did not match it.
 */
function extractStrict(entry: IntentEntry, pattern: RegExp, input: MatchInput, pass: Pass): MatchResult | null {
  const strictText = pass === 'plain' ? input.canonical() : input.repaired();
  if (!strictText) return null;
  const match = wholeTextMatch(pattern, strictText.text);
  return match ? captureResult(entry, match, input.raw, strictText, pass === 'repaired' ? strictText : null) : null;
}

function extractLoose(entry: IntentEntry, pattern: RegExp, input: MatchInput): MatchResult | null {
  const match = wholeTextMatch(pattern, input.raw);
  if (match) return captureResult(entry, match, input.raw, undefined, null);
  const offsets = input.normalized();
  const normalizedMatch = wholeTextMatch(pattern, offsets.text);
  return normalizedMatch ? captureResult(entry, normalizedMatch, input.raw, offsets, null) : null;
}

function extract(entry: IntentEntry, input: MatchInput, pass: Pass = 'plain'): MatchResult | null {
  if (!entry.pattern) return entry.parameterized ? null : { intentId: entry.intentId, captures: {} };
  return entry.strictStructure
    ? extractStrict(entry, entry.pattern, input, pass)
    : extractLoose(entry, entry.pattern, input);
}

function compilePattern(intent: Intent): RegExp | undefined {
  if (!intent.pattern) return undefined;
  try {
    return new RegExp(intent.pattern, 'di');
  } catch {
    cmdLogger.warn({ intentId: intent.id }, 'Intent pattern is invalid; argument extraction unavailable');
    return undefined;
  }
}

function addToIndex(index: Map<string, IntentEntry[]>, keys: string[], entry: IntentEntry): void {
  for (const key of new Set(keys.map(normalize))) {
    if (!key) continue;
    const rows = index.get(key) ?? [];
    rows.push(entry);
    index.set(key, rows);
  }
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
      if (intent.status === 'approved') this.indexIntent(intent);
    }
  }

  private indexIntent(intent: Intent): void {
    const requirements = captureRequirements(intent.workflow);
    if (!requirements) {
      cmdLogger.warn({ intentId: intent.id }, 'Intent workflow exceeds inspection bound; not indexed');
      return;
    }
    const entry: IntentEntry = {
      intentId: intent.id,
      ...requirements,
      strictStructure: intent.canonical_name.startsWith('basis.'),
    };
    const pattern = compilePattern(intent);
    if (pattern) entry.pattern = pattern;
    const phrases = StringArrayCodec.safeParse(intent.phrases);
    if (!phrases.success) cmdLogger.error({ intentId: intent.id }, 'Intent has invalid phrases JSON');
    else addToIndex(this.phraseMap, phrases.data, entry);
    const triggers = StringArrayCodec.safeParse(intent.trigger_words);
    if (!triggers.success) {
      cmdLogger.error({ intentId: intent.id }, 'Intent has invalid trigger_words JSON');
      return;
    }
    if (entry.pattern) addToIndex(this.triggerIndex, triggers.data, entry);
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
    if (exact?.length) return explainExactPhrase(exact, input);
    return this.explainByTriggers(text, input);
  }

  private addCandidates(candidates: Map<number, IntentEntry>, text: string): void {
    for (const word of tokenize(text))
      for (const entry of this.triggerIndex.get(word) ?? []) candidates.set(entry.intentId, entry);
  }

  private explainByTriggers(text: string, input: MatchInput): MatchDecision {
    const candidates = new Map<number, IntentEntry>();
    this.addCandidates(candidates, text);
    let results = gatherMatches(candidates, input, 'plain');
    if (results.length === 0) {
      // Nothing matched the message as written: retry once with the command words' single-letter typos repaired.
      const repaired = input.repaired();
      if (repaired) {
        this.addCandidates(candidates, repaired.text);
        results = gatherMatches(candidates, input, 'repaired');
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

function gatherMatches(pool: Map<number, IntentEntry>, input: MatchInput, pass: Pass): MatchResult[] {
  const found: MatchResult[] = [];
  for (const entry of pool.values()) {
    const result = extract(entry, input, pass);
    if (result) found.push(result);
  }
  return found;
}

/** The input is exactly a registered example phrase: one rule wins, several are ambiguous. */
function explainExactPhrase(exact: IntentEntry[], input: MatchInput): MatchDecision {
  if (exact.length !== 1)
    return { kind: 'abstain', reason: 'ambiguous', candidates: exact.map((e) => e.intentId).sort((a, b) => a - b) };
  const entry = exact[0]!;
  const result =
    entry.parameterized || entry.strictStructure ? extract(entry, input) : { intentId: entry.intentId, captures: {} };
  return result
    ? { kind: 'matched', strategy: 'exact', result }
    : { kind: 'abstain', reason: 'missing_capture', candidates: [entry.intentId] };
}

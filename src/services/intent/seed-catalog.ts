// Pure shipped seed data. Importing this module never opens or writes a database.
import { normalize } from './normalizer.ts';
import { additionalFamilies } from './seed-additional.ts';
import { calendarFamilies } from './seed-calendar.ts';
import { eventFamilies } from './seed-events.ts';
import {
  COMMON_STRINGS,
  type FamilyCategory,
  type FamilyDefinition,
  type FamilyRisk,
  type LanguageStrings,
} from './seed-fragments.ts';
import { legacyDisposition } from './seed-lineage.ts';
import { personalFamilies } from './seed-personal.ts';

export type { LegacyDispositionEntry } from './seed-lineage.ts';
export { legacyDisposition };

/** Every rule in the canonical basis lives under this namespace, apart from every earlier intent name. */
export const CANONICAL_NAMESPACE = 'basis.';

const families: FamilyDefinition[] = [
  ...calendarFamilies,
  ...eventFamilies,
  ...personalFamilies,
  ...additionalFamilies,
];

export interface CanonicalMetadata {
  name: string;
  title: string;
  category: FamilyCategory;
  risk: FamilyRisk;
  /**
   * `synthetic` phrases were written by hand for this basis. `empirical` would hold phrases
   * taken from a recorded user corpus; private corpus examples are deliberately not embedded in this public catalogue.
   */
  examples: { synthetic: string[]; empirical: string[] };
  /** Messages that must fall through to the assistant, including negated and near-miss phrasing. */
  negativeExamples: string[];
  /** Messages the pattern accepts but whose typed arguments are rejected before any tool runs. */
  invalidInputExamples: string[];
  /** Earlier keys this rule replaces (merge or rewrite); retired keys are listed in `legacyDisposition`. */
  predecessors: string[];
  tools: string[];
  notes?: string;
}

/** Include only reachable translations, not event-only template references in every rule. */
function mergedStrings(family: FamilyDefinition): LanguageStrings {
  const available = {
    ru: { ...COMMON_STRINGS.ru, ...family.strings.ru },
    en: { ...COMMON_STRINGS.en, ...family.strings.en },
  };
  const needed = new Set<string>();
  const scan = (text: string) => {
    for (const match of text.matchAll(/\{\{\s*t\.([A-Za-z_][A-Za-z0-9_]*)/g)) needed.add(match[1]!);
  };
  scan(JSON.stringify(family.steps));
  let before = -1;
  while (before !== needed.size) {
    before = needed.size;
    for (const name of [...needed]) for (const lang of ['ru', 'en'] as const) scan(available[lang][name] ?? '');
  }
  return {
    ru: Object.fromEntries(Object.entries(available.ru).filter(([key]) => needed.has(key))),
    en: Object.fromEntries(Object.entries(available.en).filter(([key]) => needed.has(key))),
  };
}

function workflowOf(family: FamilyDefinition): object {
  return {
    version: 2,
    ...(family.bindings ? { bindings: family.bindings } : {}),
    steps: family.steps,
    i18n: mergedStrings(family),
  };
}

/** Every example contributes its first word, so no positive example can be missed by the trigger index. */
function triggersOf(family: FamilyDefinition): string[] {
  const firstWords = family.examples.map((example) => normalize(example).split(' ')[0]!);
  return [...new Set([...family.triggers.map(normalize), ...firstWords])];
}

export const seedIntents: Array<{
  canonical_name: string;
  pattern: string;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
}> = families.map((family) => ({
  canonical_name: family.name,
  pattern: family.pattern,
  workflow: workflowOf(family),
  phrases: [family.examples[0]!],
  trigger_words: triggersOf(family),
  source_message: family.examples[0]!,
}));

function toolsOf(family: FamilyDefinition): string[] {
  return [...new Set(family.steps.flatMap((step) => (step.call ? [step.call] : [])))];
}

export const canonicalMetadata: CanonicalMetadata[] = families.map((family) => ({
  name: family.name,
  title: family.title,
  category: family.category,
  risk: family.risk,
  examples: { synthetic: family.examples, empirical: [] },
  negativeExamples: family.negatives,
  invalidInputExamples: family.invalidInputs ?? [],
  predecessors: legacyDisposition
    .filter((entry) => entry.target === family.name)
    .map((entry) => entry.oldKey)
    .sort(),
  tools: toolsOf(family),
  ...(family.notes ? { notes: family.notes } : {}),
}));

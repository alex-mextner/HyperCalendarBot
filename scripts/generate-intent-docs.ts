/**
 * Deterministic source SSG for the canonical intent basis. It reads only the current seed, its metadata
 * and the lineage table; it never opens a database and never imports the mutating seeder.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Marked } from 'marked';
import { z } from 'zod';
import { auditDefinition } from '../src/services/intent/catalog-audit.ts';
import { IntentMatcher } from '../src/services/intent/intent-matcher.ts';
import {
  type CanonicalMetadata,
  canonicalMetadata,
  type LegacyDispositionEntry,
  legacyDisposition,
  seedIntents,
} from '../src/services/intent/seed-catalog.ts';
import { seedFingerprint } from '../src/services/intent/seed-replacement.ts';
import { BindingSchema } from '../src/services/intent/workflow-bindings.ts';
import type { WorkflowInputValue } from '../src/services/intent/workflow-input.ts';
import { type I18nMap, type Level2Step, WorkflowSchema } from '../src/services/intent/workflow-schema.ts';
import { jsonCodec } from '../src/utils/json-codec.ts';
import {
  bindingTypeTitles,
  canonicalTitles,
  categoryTitles,
  dispositionTitles,
  legacyTitles,
  riskTitles,
} from './intent-doc-labels.ts';

const DOCS_DIRECTORY = resolve(import.meta.dir, '../docs/intents');
const SEED_SOURCE_PATH = 'src/services/intent/seed-catalog.ts';
const LINEAGE_FILE = 'db-lineage.json';

type Seed = (typeof seedIntents)[number];
type Disposition = LegacyDispositionEntry['disposition'];
const DISPOSITIONS: Disposition[] = ['merge', 'rewrite', 'retire'];

// ─── source data ────────────────────────────────────────────────────────────

const TOOL_NAME = /^[a-z][a-z0-9_]{0,80}$/;
const KEY_NAME = /^[a-z0-9_.-]{1,80}$/i;
const DatabaseLineageEntry = z
  .object({
    id: z.number().int().positive(),
    oldName: z.string().regex(KEY_NAME),
    oldKey: z.string().regex(KEY_NAME),
    status: z.string().regex(/^[a-z_]{1,32}$/),
    disposition: z.enum(['merge', 'rewrite', 'retire']),
    target: z.string().nullable(),
    reason: z.string().min(1).max(480),
    previousTools: z.array(z.string().regex(TOOL_NAME)).max(16),
  })
  .strict();
const DatabaseLineageFile = z
  .object({
    schemaVersion: z.literal(1),
    cohort: z.string().regex(KEY_NAME),
    capturedAt: z.string().max(40),
    counts: z.object({ merge: z.number(), rewrite: z.number(), retire: z.number() }).strict(),
    entries: z.array(DatabaseLineageEntry),
    note: z.string().max(600),
  })
  .strict()
  .refine((file) => new Set(file.entries.map((entry) => entry.id)).size === file.entries.length, 'Duplicate legacy id')
  .refine(
    (file) => DISPOSITIONS.every((d) => file.counts[d] === file.entries.filter((e) => e.disposition === d).length),
    'Declared counts differ from the entries',
  );
export type DatabaseLineage = z.infer<typeof DatabaseLineageFile>;

/** The cohort recorded from a live database, sanitized to generic meaning; absent until provided. */
export function readDatabaseLineage(path = resolve(DOCS_DIRECTORY, LINEAGE_FILE)): DatabaseLineage | null {
  if (!existsSync(path)) return null;
  const parsed = jsonCodec(DatabaseLineageFile).safeParse(readFileSync(path, 'utf8'));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid ${LINEAGE_FILE}: ${problems.join('; ')}`);
  }
  return parsed.data;
}

export interface CatalogueSource {
  seed: readonly Seed[];
  metadata: readonly CanonicalMetadata[];
  lineage: readonly LegacyDispositionEntry[];
  databaseLineage: DatabaseLineage | null;
}

export function currentSource(): CatalogueSource {
  return {
    seed: seedIntents,
    metadata: canonicalMetadata,
    lineage: legacyDisposition,
    databaseLineage: readDatabaseLineage(),
  };
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => seen.size === seen.add(value).size);
}

function assertNames(source: CatalogueSource): void {
  const [duplicate] = duplicates(source.seed.map((rule) => rule.canonical_name));
  if (duplicate) throw new Error(`Duplicate intent key: ${duplicate}`);
  const [metaDuplicate] = duplicates(source.metadata.map((meta) => meta.name));
  if (metaDuplicate) throw new Error(`Duplicate metadata key: ${metaDuplicate}`);
  const names = new Set(source.seed.map((rule) => rule.canonical_name));
  const missing = source.metadata.filter((meta) => !names.has(meta.name)).map((meta) => meta.name);
  const undescribed = source.seed.filter((rule) => !source.metadata.some((meta) => meta.name === rule.canonical_name));
  if (missing.length || undescribed.length)
    throw new Error(
      `Seed and metadata differ: ${[...missing, ...undescribed.map((rule) => rule.canonical_name)].join(', ')}`,
    );
}

function assertLabels(source: CatalogueSource): void {
  for (const meta of source.metadata) {
    if (!canonicalTitles[meta.name]) throw new Error(`Missing Russian title for ${meta.name}`);
    if (!categoryTitles[meta.category]) throw new Error(`Missing category label for ${meta.category}`);
    if (!riskTitles[meta.risk]) throw new Error(`Missing risk label for ${meta.risk}`);
  }
  for (const entry of source.lineage)
    if (!legacyTitles[entry.oldKey]) throw new Error(`Missing Russian title for earlier rule ${entry.oldKey}`);
}

function assertLineage(source: CatalogueSource): void {
  const [duplicate] = duplicates(source.lineage.map((entry) => entry.oldKey));
  if (duplicate) throw new Error(`Duplicate lineage key: ${duplicate}`);
  const names = new Set(source.seed.map((rule) => rule.canonical_name));
  for (const entry of source.lineage) {
    if (entry.disposition === 'retire' ? entry.target !== null : !entry.target || !names.has(entry.target))
      throw new Error(`Lineage ${entry.oldKey} points at an unknown target`);
  }
  for (const record of source.databaseLineage?.entries ?? [])
    if (record.disposition === 'retire' ? record.target !== null : !record.target || !names.has(record.target))
      throw new Error(`Database lineage ${record.id} points at an unknown target`);
}

// ─── entries ────────────────────────────────────────────────────────────────

interface Probe {
  example: string;
  result: string;
}

export interface CatalogueEntry {
  name: string;
  title: string;
  sourceTitle: string;
  category: string;
  risk: string;
  origin: 'canonical';
  source: string;
  deployed: null;
  examples: string[];
  negativeExamples: string[];
  invalidInputExamples: string[];
  pattern: string;
  workflow: object;
  tools: string[];
  bindingTypes: string[];
  notes: string | null;
  predecessors: { key: string; title: string; disposition: Disposition }[];
  issues: string[];
  audit: ReturnType<typeof auditDefinition>;
  matching: Probe[];
  negativeMatching: Probe[];
  invalidInputMatching: Probe[];
}

function loadMatcher(seed: readonly Seed[]): IntentMatcher {
  const matcher = new IntentMatcher();
  matcher.load(
    seed.map((rule, index) => ({
      id: index + 1,
      canonical_name: rule.canonical_name,
      phrases: JSON.stringify(rule.phrases),
      trigger_words: JSON.stringify(rule.trigger_words),
      pattern: rule.pattern,
      workflow: JSON.stringify(rule.workflow),
      format: 'text',
      status: 'approved' as const,
      source_message: rule.source_message,
      created_at: '',
    })),
  );
  return matcher;
}

/** `own`: routed to this rule; `different`: routed to another rule; anything else is the abstention reason. */
function positiveProbe(matcher: IntentMatcher, id: number, example: string): Probe {
  const decision = matcher.explain(example);
  if (decision.kind === 'abstain') return { example, result: decision.reason };
  return { example, result: decision.result.intentId === id ? 'own' : 'different' };
}

function negativeProbe(matcher: IntentMatcher, example: string): Probe {
  return { example, result: matcher.explain(example).kind === 'abstain' ? 'fallthrough' : 'matched' };
}

function bindingTypesOf(workflow: object): string[] {
  const parsed = WorkflowSchema.parse(workflow);
  return [...new Set(Object.values(parsed.version === 2 ? (parsed.bindings ?? {}) : {}).map((b) => b.type))];
}

function issuesOf(audit: CatalogueEntry['audit'], matching: Probe[], negatives: Probe[], invalid: Probe[]): string[] {
  return [
    ...(audit.schemaValid ? [] : ['schema']),
    ...(audit.contractErrors ? ['tool_contract'] : []),
    ...(matching.some((probe) => probe.result !== 'own') ? ['positive_routing'] : []),
    ...(negatives.some((probe) => probe.result === 'own') ? ['negative_matched'] : []),
    ...(invalid.some((probe) => probe.result !== 'own') ? ['invalid_input_routing'] : []),
  ];
}

function buildEntry(
  rule: Seed,
  meta: CanonicalMetadata,
  id: number,
  matcher: IntentMatcher,
  lineage: readonly LegacyDispositionEntry[],
): CatalogueEntry {
  const examples = [...new Set([...meta.examples.synthetic, ...meta.examples.empirical, rule.source_message])];
  const matching = examples.map((example) => positiveProbe(matcher, id, example));
  const negativeMatching = meta.negativeExamples.map((example) => negativeProbe(matcher, example));
  const invalidInputMatching = meta.invalidInputExamples.map((example) => positiveProbe(matcher, id, example));
  const audit = auditDefinition(rule);
  return {
    name: rule.canonical_name,
    title: canonicalTitles[meta.name]!,
    sourceTitle: meta.title,
    category: meta.category,
    risk: meta.risk,
    origin: 'canonical',
    source: SEED_SOURCE_PATH,
    deployed: null,
    examples,
    negativeExamples: [...meta.negativeExamples],
    invalidInputExamples: [...meta.invalidInputExamples],
    pattern: rule.pattern,
    workflow: rule.workflow,
    tools: [...meta.tools],
    bindingTypes: bindingTypesOf(rule.workflow),
    notes: meta.notes ?? null,
    predecessors: lineage
      .filter((entry) => entry.target === rule.canonical_name)
      .map((entry) => ({ key: entry.oldKey, title: legacyTitles[entry.oldKey]!, disposition: entry.disposition }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    issues: issuesOf(audit, matching, negativeMatching, invalidInputMatching),
    audit,
    matching,
    negativeMatching,
    invalidInputMatching,
  };
}

// ─── catalogue ──────────────────────────────────────────────────────────────

function tally(values: readonly string[]): { [key: string]: number } {
  const counts: { [key: string]: number } = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function bindingTypeNames(): string[] {
  return BindingSchema.options.map((option) => option.shape.type.value);
}

function buildLineage(source: CatalogueSource) {
  const counts = tally(source.lineage.map((entry) => entry.disposition));
  const targets = new Set(source.lineage.flatMap((entry) => (entry.target ? [entry.target] : [])));
  return {
    source: {
      total: source.lineage.length,
      merge: counts.merge ?? 0,
      rewrite: counts.rewrite ?? 0,
      retire: counts.retire ?? 0,
      distinctTargets: targets.size,
      entries: source.lineage.map((entry) => ({
        oldKey: entry.oldKey,
        oldTitle: legacyTitles[entry.oldKey]!,
        disposition: entry.disposition,
        target: entry.target,
        reason: entry.reason,
      })),
    },
    database: {
      provided: source.databaseLineage !== null,
      total: source.databaseLineage?.entries.length ?? 0,
      merge: source.databaseLineage?.counts.merge ?? 0,
      rewrite: source.databaseLineage?.counts.rewrite ?? 0,
      retire: source.databaseLineage?.counts.retire ?? 0,
      entries: source.databaseLineage?.entries ?? [],
    },
  };
}

export function buildCatalogue(source: CatalogueSource = currentSource()) {
  assertNames(source);
  assertLabels(source);
  assertLineage(source);
  const matcher = loadMatcher(source.seed);
  const entries = source.seed.map((rule, index) =>
    buildEntry(
      rule,
      source.metadata.find((meta) => meta.name === rule.canonical_name)!,
      index + 1,
      matcher,
      source.lineage,
    ),
  );
  const usage = tally(entries.flatMap((entry) => entry.bindingTypes));
  return {
    schemaVersion: 2,
    fingerprint: seedFingerprint(source.seed),
    runtimeVerification: null,
    engine: {
      document: 'engine.md',
      bindingTypes: bindingTypeNames().map((type) => ({
        type,
        title: bindingTypeTitles[type] ?? type,
        uses: usage[type] ?? 0,
      })),
    },
    counts: {
      rules: entries.length,
      categories: tally(entries.map((entry) => entry.category)),
      risks: tally(entries.map((entry) => entry.risk)),
      tools: new Set(entries.flatMap((entry) => entry.tools)).size,
    },
    entries,
    lineage: buildLineage(source),
  };
}
type Catalogue = ReturnType<typeof buildCatalogue>;

// ─── escaping and text segments ─────────────────────────────────────────────

const HTML_ESCAPES: { [char: string]: string } = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (value: unknown): string => String(value ?? '—').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);

/** Text for Markdown: HTML-escaped, with every Markdown control character written as an entity. */
const escapeMarkdown = (value: unknown): string =>
  escapeHtml(value)
    .replace(/[[\]()`|*_\\~!#]/g, (char) => `&#${char.charCodeAt(0)};`)
    .replace(/\r?\n/g, '<br>');

function longestRun(text: string, char: string): number {
  return Math.max(0, ...(text.match(new RegExp(`${char}+`, 'g')) ?? []).map((run) => run.length));
}

function codeSpan(text: string): string {
  const flat = text.replace(/\r?\n/g, ' ');
  const fence = '`'.repeat(longestRun(flat, '`') + 1);
  return `${fence} ${flat} ${fence}`;
}

function codeBlock(text: string, language: string): string {
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

interface Segment {
  text: string;
  code?: boolean;
}
const say = (text: string): Segment => ({ text });
const lit = (text: string): Segment => ({ text, code: true });
const markdownOf = (segments: Segment[]): string =>
  segments.map((s) => (s.code ? codeSpan(s.text) : escapeMarkdown(s.text))).join('');
const htmlOf = (segments: Segment[]): string =>
  segments.map((s) => (s.code ? `<code>${escapeHtml(s.text)}</code>` : escapeHtml(s.text))).join('');

// ─── workflow descriptions ──────────────────────────────────────────────────

interface WorkflowView {
  bindings: [string, Record<string, unknown>][];
  steps: Level2Step[];
  ru: { [key: string]: string };
}

function viewOf(workflow: object): WorkflowView {
  const parsed = WorkflowSchema.parse(workflow);
  const i18n: I18nMap = parsed.i18n ?? {};
  return {
    bindings: parsed.version === 2 ? Object.entries(parsed.bindings ?? {}) : [],
    steps: 'steps' in parsed ? (parsed.steps as Level2Step[]) : [],
    ru: i18n.ru ?? {},
  };
}

function resolveText(template: string, ru: { [key: string]: string }): string {
  return template.replace(/\{\{\s*t\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, key: string) => ru[key] ?? whole);
}

function valueText(value: WorkflowInputValue, ru: { [key: string]: string }): string {
  return typeof value === 'string' ? resolveText(value, ru) : JSON.stringify(value);
}

function describeQuestion(step: Level2Step, ru: { [key: string]: string }): Segment[] {
  const question = step.input?.question;
  const options = step.input?.options;
  const segments = [say('спросить пользователя: «'), say(valueText(question ?? '', ru)), say('»')];
  if (Array.isArray(options))
    segments.push(say(`; варианты ответа: ${options.map((option) => `«${valueText(option, ru)}»`).join(', ')}`));
  return segments;
}

function describeCall(step: Level2Step, ru: { [key: string]: string }): Segment[] {
  const segments = [say('вызвать инструмент '), lit(step.call ?? '')];
  const pairs = Object.entries(step.input ?? {});
  if (!pairs.length) return segments;
  segments.push(say(' с параметрами: '));
  pairs.forEach(([key, value], index) => {
    if (index > 0) segments.push(say('; '));
    segments.push(lit(key), say(' = '), lit(valueText(value, ru)));
  });
  return segments;
}

function capitalize(segments: Segment[]): Segment[] {
  const [first, ...rest] = segments;
  return first && !first.code
    ? [{ text: first.text.charAt(0).toUpperCase() + first.text.slice(1) }, ...rest]
    : segments;
}

function describeStep(step: Level2Step, ru: { [key: string]: string }): Segment[] {
  const body =
    step.respond !== undefined
      ? [say('ответить пользователю: «'), say(resolveText(step.respond, ru)), say('»')]
      : step.call === 'ask_user'
        ? describeQuestion(step, ru)
        : describeCall(step, ru);
  const withResult = step.as ? [...body, say('; результат сохранить как '), lit(step.as)] : body;
  const stopped = step.stop ? [...withResult, say('; на этом завершить')] : withResult;
  return step.when ? [say('Если выполняется условие '), lit(step.when), say(', то '), ...stopped] : capitalize(stopped);
}

function describeBinding(name: string, binding: Record<string, unknown>): Segment[] {
  const type = String(binding.type);
  const segments = [lit(name), say(` — ${bindingTypeTitles[type] ?? type}`)];
  for (const [key, value] of Object.entries(binding)) {
    if (key === 'type') continue;
    if (value !== null && typeof value === 'object')
      segments.push(
        say(`; таблица «${key}»: ${Array.isArray(value) ? value.length : Object.keys(value).length} значений`),
      );
    else segments.push(say('; '), lit(`${key} = ${String(value)}`));
  }
  return segments;
}

// ─── shared grouping and wording ────────────────────────────────────────────

function groupByCategory(entries: readonly CatalogueEntry[]): { category: string; entries: CatalogueEntry[] }[] {
  const order = Object.keys(categoryTitles);
  const categories = [...new Set(entries.map((entry) => entry.category))].sort(
    (a, b) => (order.indexOf(a) + 1 || order.length + 1) - (order.indexOf(b) + 1 || order.length + 1),
  );
  return categories.map((category) => ({ category, entries: entries.filter((entry) => entry.category === category) }));
}

const categoryTitle = (category: string): string => categoryTitles[category] ?? category;
const riskTitle = (risk: string): string => riskTitles[risk] ?? risk;

function checkSummary(entry: CatalogueEntry): string {
  const total = entry.matching.length;
  if (entry.issues.length) return `Требует внимания: ${entry.issues.join(', ')}.`;
  const negatives = entry.negativeMatching.length;
  return `Все ${total} положительных примеров ведут в это правило, все ${negatives} отрицательных уходят к AI. Это проверка маршрутизации при сборке, а не приёмка на живом боте.`;
}

const CORPUS_NOTE =
  'Примеры в карточках составлены вручную. Отдельный приватный replay выполнен на 402 сохранённых естественных сообщениях; персональные тексты и статистика не включаются в публичные карточки. Результаты replay не считаются точностью или доказательством успешного действия.';

// ─── Markdown ───────────────────────────────────────────────────────────────

const bulletList = (items: readonly string[]): string => items.map((item) => `- ${escapeMarkdown(item)}`).join('\n');

function renderRuleBody(entry: CatalogueEntry): string[] {
  const view = viewOf(entry.workflow);
  const parts: string[] = [];
  parts.push(`**Примеры фраз.**\n\n${bulletList(entry.examples)}`);
  if (entry.negativeExamples.length)
    parts.push(`**Не запускают правило (уходят к AI):**\n\n${bulletList(entry.negativeExamples)}`);
  if (entry.invalidInputExamples.length)
    parts.push(
      `**Шаблон принимает, но привязка отвергает до вызова инструментов:**\n\n${bulletList(entry.invalidInputExamples)}`,
    );
  parts.push(
    `**Что делает правило по шагам.**\n\n${view.steps.map((step, index) => `${index + 1}. ${markdownOf(describeStep(step, view.ru))}`).join('\n')}`,
  );
  if (view.bindings.length)
    parts.push(
      `**Что читается из сообщения (привязки).**\n\n${view.bindings.map(([name, binding]) => `- ${markdownOf(describeBinding(name, binding))}`).join('\n')}`,
    );
  return parts;
}

function renderPredecessors(entry: CatalogueEntry): string {
  if (!entry.predecessors.length) return '';
  const items = entry.predecessors.map(
    (p) =>
      `${codeSpan(p.key)} (${escapeMarkdown(p.title)}; ${escapeMarkdown(dispositionTitles[p.disposition]!.toLowerCase())})`,
  );
  return `**Заменяет прежние правила:** ${items.join(', ')}.`;
}

function renderRuleMarkdown(entry: CatalogueEntry): string {
  const meta = [
    codeSpan(entry.name),
    escapeMarkdown(categoryTitle(entry.category)),
    escapeMarkdown(riskTitle(entry.risk)),
    `инструменты: ${entry.tools.map(codeSpan).join(', ') || 'нет, ответ без инструмента'}`,
  ].join(' · ');
  const notes = entry.notes ? `> Пометка из исходника (по-английски): ${escapeMarkdown(entry.notes)}` : '';
  const technical = `<details>\n<summary>Регулярное выражение и полный workflow (JSON)</summary>\n\n${codeBlock(entry.pattern, 'text')}\n\n${codeBlock(JSON.stringify(entry.workflow, null, 2), 'json')}\n\n</details>`;
  return [
    `<a id="${escapeHtml(entry.name)}"></a>\n### ${escapeMarkdown(entry.title)}`,
    meta,
    notes,
    ...renderRuleBody(entry),
    renderPredecessors(entry),
    `**Проверка при сборке.** ${escapeMarkdown(checkSummary(entry))}`,
    technical,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderCounts(c: Catalogue): string {
  const categories = tally(c.entries.map((entry) => entry.category));
  const risks = tally(c.entries.map((entry) => entry.risk));
  const rows = [
    `| Правил в целевом сиде | ${c.entries.length} |`,
    ...Object.entries(categories).map(([key, n]) => `| Категория: ${escapeMarkdown(categoryTitle(key))} | ${n} |`),
    ...Object.entries(risks).map(([key, n]) => `| Риск: ${escapeMarkdown(riskTitle(key))} | ${n} |`),
  ];
  return `| Показатель | Значение |\n|---|---|\n${rows.join('\n')}`;
}

function renderIndexTable(c: Catalogue): string {
  const rows = c.entries.map(
    (e) =>
      `| [${escapeMarkdown(e.title)}](#${e.name}) | ${escapeMarkdown(categoryTitle(e.category))} | ${escapeMarkdown(riskTitle(e.risk))} | ${e.issues.length ? escapeMarkdown(e.issues.join(', ')) : 'маршрутизация проверена'} |`,
  );
  return `| Правило | Категория | Риск | Проверка при сборке |\n|---|---|---|---|\n${rows.join('\n')}`;
}

function renderLineageTable(c: Catalogue): string {
  const anchors = new Map(c.entries.map((entry) => [entry.name, entry.title]));
  const rank = (d: Disposition) => DISPOSITIONS.indexOf(d);
  const rows = [...c.lineage.source.entries]
    .sort((a, b) => rank(a.disposition) - rank(b.disposition) || a.oldKey.localeCompare(b.oldKey))
    .map((e) => {
      const target = e.target ? `[${escapeMarkdown(anchors.get(e.target) ?? e.target)}](#${e.target})` : 'нет замены';
      return `| ${codeSpan(e.oldKey)} | ${escapeMarkdown(e.oldTitle)} | ${escapeMarkdown(dispositionTitles[e.disposition])} | ${target} | ${escapeMarkdown(e.reason)} |`;
    });
  return `| Прежний ключ | Прежний заголовок | Что стало | Новое правило | Причина (текст из исходника, по-английски) |\n|---|---|---|---|---|\n${rows.join('\n')}`;
}

function lineageSummary(c: Catalogue): string {
  const s = c.lineage.source;
  return `Прежних правил: **${s.total}**. Слито в общие: **${s.merge}**; переписано заново: **${s.rewrite}**; выведено без замены: **${s.retire}**. Слитые и переписанные правила собраны в **${s.distinctTargets}** правил единого сида.`;
}

function renderDatabaseCohort(c: Catalogue): string {
  const db = c.lineage.database;
  const heading = '### Когорта живой базы (учитывается отдельно)';
  if (!db.provided)
    return `${heading}\n\nСанитизированный список правил из живой базы для этой сборки не предоставлен (\`${LINEAGE_FILE}\` отсутствует). Сравнения с базой здесь нет.`;
  const rows = db.entries.map(
    (e) =>
      `| ${e.id} | ${codeSpan(e.oldKey)} | ${escapeMarkdown(e.status)} | ${escapeMarkdown(dispositionTitles[e.disposition])} | ${e.target ? codeSpan(e.target) : 'нет замены'} | ${escapeMarkdown(e.previousTools.join(', ') || '—')} | ${escapeMarkdown(e.reason)} |`,
  );
  return `${heading}\n\nПравил, найденных в живой базе: **${db.total}** (слито ${db.merge}, переписано ${db.rewrite}, выведено ${db.retire}). Это другая группа, а не добавка к ${c.lineage.source.total} прежним правилам из исходников выше: числа не складываются. Записи содержат только обобщённый смысл, без текста сообщений и без идентификаторов пользователей.\n\n<details>\n<summary>Таблица живой базы (${db.total})</summary>\n\n| Номер | Прежний ключ | Статус | Что стало | Новое правило | Прежние инструменты | Причина |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n</details>`;
}

function renderLineageSection(c: Catalogue): string {
  return `## Происхождение: от прежних правил к единому сиду\n\n${lineageSummary(c)}\n\n<details>\n<summary>Все прежние правила из исходников (${c.lineage.source.total})</summary>\n\n${renderLineageTable(c)}\n\n</details>\n\n${renderDatabaseCohort(c)}`;
}

const HOW_TO = `## Как создать и пересобрать документацию

\`\`\`bash
bun run docs:intents          # пересобрать README.md, index.html и catalogue.json
bun run docs:intents:check    # завершится ошибкой, если файлы отстали от исходников
bun --no-env-file scripts/verify-intent-docs.ts   # проверить настоящую страницу в Chromium
\`\`\`

Новое правило описывается в исходниках сида, русский заголовок добавляется в [\`intent-doc-labels.ts\`](../../scripts/intent-doc-labels.ts), затем документация пересобирается. Обычный тестовый прогон сравнивает исходники со всеми тремя файлами. Безопасное применение сида к базе (пробный запуск, резервная копия, применение) описано в [движке](engine.md#безопасная-миграция-базы-сначала-пробный-запуск).`;

function renderIntroduction(c: Catalogue): string {
  return `# Правила интентов HyperCalendar: единый сид

**Это целевой сид из исходного кода: правил — ${c.entries.length}.** Документ строится из исходников и **не утверждает, что сид уже установлен**: сборка не открывает базу и не видит сервер. Установку подтверждает отдельная проверка живой базы: отпечаток ниже должен совпасть со значением в таблице \`intent_basis_manifest\` (подробности в [описании движка](engine.md#что-здесь-утверждается-а-что-нет)).

Отпечаток целевого сида: \`${c.fingerprint}\`

Навигация: [описание движка и правил безопасности](engine.md) · [HTML-страница с поиском и фильтрами](index.html) · [машиночитаемый каталог](catalogue.json) · [заметки по каталогу и приватному отчёту](../intent-catalogue.md) · [план перестройки](../plans/2026-09-18-intent-redesign.md)

${CORPUS_NOTE} Статистика из живой базы в публичный каталог не включается.`;
}

function renderGlossary(): string {
  return `## Как читать описание шагов

В шагах встречаются подстановки: \`{{$1}}\` — фрагмент сообщения по номеру группы шаблона; \`{{bind.имя}}\` — уже проверенное значение привязки; \`{{t.имя}}\` — строка перевода (в описании она уже раскрыта на русском); \`{{env.scope}}\` — \`group\` в группе или \`personal\` в личном чате; \`{{tool_outputs.имя}}\` — результат предыдущего шага. Условие шага (\`when\`) выполняется, только если оно истинно; иначе шаг пропускается.`;
}

export function renderMarkdown(c: Catalogue): string {
  const groups = groupByCategory(c.entries).map(
    (group) =>
      `## ${escapeMarkdown(categoryTitle(group.category))}\n\n${group.entries.map(renderRuleMarkdown).join('\n\n---\n\n')}`,
  );
  return `${[
    '<!-- Generated by bun run docs:intents; do not edit. -->',
    renderIntroduction(c),
    `## Сводка\n\n${renderCounts(c)}`,
    renderLineageSummaryLine(c),
    HOW_TO,
    renderGlossary(),
    `## Все правила\n\n${renderIndexTable(c)}`,
    ...groups,
    renderLineageSection(c),
  ].join('\n\n')}\n`;
}

function renderLineageSummaryLine(c: Catalogue): string {
  return `Прежние правила из исходников: ${c.lineage.source.total} (слито ${c.lineage.source.merge}, переписано ${c.lineage.source.rewrite}, выведено ${c.lineage.source.retire}); ${c.lineage.database.provided ? `живая база: ${c.lineage.database.total}, считается отдельно` : 'когорта живой базы не предоставлена'}. Подробности в разделе [«Происхождение»](#происхождение-от-прежних-правил-к-единому-сиду).`;
}

// ─── HTML ───────────────────────────────────────────────────────────────────

const HTML_STYLES = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#f6f5fa;color:#211c34;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:clamp(28px,5vw,46px);line-height:1.15;margin:.3em 0}
h2{font-size:clamp(22px,3.4vw,30px);margin:1.6em 0 .5em}
h3{font-size:19px;margin:0 0 6px;overflow-wrap:anywhere}
h4{font-size:17px;margin:1.2em 0 .4em}
p,li{overflow-wrap:anywhere}
a{color:#5b32a8}
a:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #5b32a8;outline-offset:2px}
.skip,.sr{position:absolute;left:-999px}
.skip:focus{left:16px;top:8px;background:#fff;padding:8px;z-index:2}
.brand{font-weight:750;color:#5b32a8;margin:0}
.lead{max-width:860px;color:#4d4360}
.notice{background:#eee7fa;padding:16px 20px;border-radius:12px;margin:20px 0}
.metrics{display:flex;flex-wrap:wrap;gap:12px;list-style:none;padding:0;margin:20px 0}
.metrics li{flex:1 1 150px;min-width:0;background:#fff;border-radius:12px;padding:14px 16px}
.metrics b{display:block;font-size:30px;line-height:1.2}
.jump{display:flex;flex-wrap:wrap;gap:8px 18px;margin:18px 0}
#engine,#lineage{background:#fff;border:1px solid #e2dcef;border-radius:14px;padding:4px 20px 20px;margin-top:24px}
.filters{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}
.filters label{display:flex;flex-direction:column;flex:1 1 200px;min-width:0;font-size:14px;font-weight:600;gap:4px}
input,select{font:inherit;border:1px solid #b9aed0;border-radius:10px;padding:10px 12px;background:#fff;color:inherit;min-width:0;width:100%}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
article{background:#fff;border:1px solid #e2dcef;border-radius:14px;padding:18px;min-width:0}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px;padding:0;list-style:none}
.chip{font-size:12px;background:#ece7f7;color:#3e2a72;border-radius:6px;padding:3px 8px}
.chip.write{background:#fff1d2;color:#6b4708}
.chip.sensitive_write{background:#fde2e2;color:#7a1f1f}
.chip.warn{background:#fde2e2;color:#7a1f1f}
code,pre{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
code{background:#f1eef8;border-radius:4px;padding:1px 4px;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1eef8;border-radius:8px;padding:12px;margin:8px 0}
pre code{background:none;padding:0}
details{margin:10px 0}
summary{cursor:pointer;font-weight:600}
.scroll{overflow-x:auto;max-width:100%}
table{border-collapse:collapse;font-size:14px;min-width:100%}
th,td{border:1px solid #d9d1ea;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f1eef8}
.hidden{display:none}
footer{margin-top:40px;font-size:13px;color:#4d4360;overflow-wrap:anywhere}
@media(max-width:700px){.grid{grid-template-columns:minmax(0,1fr)}main{padding:16px 12px 40px}#engine,#lineage{padding:2px 12px 14px}}
`;

const HTML_SCRIPT = `
(function () {
  var search = document.getElementById('search');
  var category = document.getElementById('category');
  var risk = document.getElementById('risk');
  var counter = document.getElementById('count');
  var empty = document.getElementById('empty');
  var cards = [].slice.call(document.querySelectorAll('article[data-name]'));
  function apply() {
    var text = search.value.toLowerCase().trim();
    var shown = 0;
    cards.forEach(function (card) {
      var visible = (!category.value || card.dataset.category === category.value) &&
        (!risk.value || card.dataset.risk === risk.value) &&
        card.dataset.search.indexOf(text) !== -1;
      card.classList.toggle('hidden', !visible);
      if (visible) shown++;
    });
    counter.textContent = 'Показано: ' + shown + ' из ' + cards.length;
    empty.hidden = shown !== 0;
  }
  [search, category, risk].forEach(function (control) {
    control.addEventListener('input', apply);
    control.addEventListener('change', apply);
  });
  apply();
})();
`;

function readEngineMarkdown(): string {
  return readFileSync(resolve(DOCS_DIRECTORY, 'engine.md'), 'utf8');
}

/** Engine text for the page: headings drop one level under the page title and wide tables scroll inside a wrapper. */
function renderEngineHtml(markdown: string): string {
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const level = Math.min(depth + 1, 6);
        return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
      table(token) {
        const head = token.header
          .map((cell) => `<th scope="col">${this.parser.parseInline(cell.tokens)}</th>`)
          .join('');
        const rows = token.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${this.parser.parseInline(cell.tokens)}</td>`).join('')}</tr>`)
          .join('');
        return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  return marked.parse(markdown, { async: false });
}

function renderBindingTypesHtml(c: Catalogue): string {
  const usage = tally(c.entries.flatMap((entry) => entry.bindingTypes));
  const rows = c.engine.bindingTypes
    .map(
      (b) =>
        `<tr><td><code>${escapeHtml(b.type)}</code></td><td>${escapeHtml(b.title)}</td><td>${usage[b.type] ?? 0}</td></tr>`,
    )
    .join('');
  return `<h3>Типы привязок в исходном коде и число правил, где они используются</h3><div class="scroll"><table><thead><tr><th scope="col">Тип</th><th scope="col">Что читает</th><th scope="col">Правил с этим типом</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function listHtml(items: readonly string[], tag: 'ul' | 'ol' = 'ul'): string {
  return `<${tag}>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
}

function renderCardDetails(entry: CatalogueEntry): string {
  const view = viewOf(entry.workflow);
  const steps = view.steps.map((step) => `<li>${htmlOf(describeStep(step, view.ru))}</li>`).join('');
  const bindings = view.bindings
    .map(([name, binding]) => `<li>${htmlOf(describeBinding(name, binding))}</li>`)
    .join('');
  const predecessors = entry.predecessors
    .map(
      (p) =>
        `<li><code>${escapeHtml(p.key)}</code> (${escapeHtml(p.title)}; ${escapeHtml(dispositionTitles[p.disposition]!.toLowerCase())})</li>`,
    )
    .join('');
  return [
    `<h4>Примеры фраз</h4>${listHtml(entry.examples)}`,
    entry.negativeExamples.length ? `<h4>Уходят к AI</h4>${listHtml(entry.negativeExamples)}` : '',
    entry.invalidInputExamples.length
      ? `<h4>Привязка отвергает до вызова инструментов</h4>${listHtml(entry.invalidInputExamples)}`
      : '',
    `<h4>Шаги</h4><ol>${steps}</ol>`,
    bindings ? `<h4>Привязки</h4><ul>${bindings}</ul>` : '',
    predecessors ? `<h4>Заменяет прежние правила</h4><ul>${predecessors}</ul>` : '',
    `<h4>Проверка при сборке</h4><p>${escapeHtml(checkSummary(entry))}</p>`,
    `<details><summary>Регулярное выражение и полный workflow (JSON)</summary><pre>${escapeHtml(entry.pattern)}</pre><pre>${escapeHtml(JSON.stringify(entry.workflow, null, 2))}</pre></details>`,
  ].join('');
}

function searchText(entry: CatalogueEntry): string {
  return [
    entry.name,
    entry.title,
    categoryTitle(entry.category),
    riskTitle(entry.risk),
    ...entry.tools,
    ...entry.examples,
    ...entry.predecessors.flatMap((p) => [p.key, p.title]),
  ]
    .join(' ')
    .toLowerCase();
}

function renderCard(entry: CatalogueEntry): string {
  const note = entry.notes
    ? `<p><small>Пометка из исходника (по-английски): ${escapeHtml(entry.notes)}</small></p>`
    : '';
  return `<article id="${escapeHtml(entry.name)}" data-name="${escapeHtml(entry.name)}" data-category="${escapeHtml(entry.category)}" data-risk="${escapeHtml(entry.risk)}" data-search="${escapeHtml(searchText(entry))}"><h3>${escapeHtml(entry.title)}</h3><ul class="chips"><li class="chip">${escapeHtml(categoryTitle(entry.category))}</li><li class="chip ${escapeHtml(entry.risk)}">${escapeHtml(riskTitle(entry.risk))}</li>${entry.issues.length ? `<li class="chip warn">Требует внимания: ${escapeHtml(entry.issues.join(', '))}</li>` : ''}</ul><p><code>${escapeHtml(entry.name)}</code></p><p>Инструменты: ${escapeHtml(entry.tools.join(', ') || 'нет, ответ без инструмента')}</p>${note}<details><summary>Подробности: примеры, шаги, привязки, JSON</summary>${renderCardDetails(entry)}</details></article>`;
}

function optionsHtml(counts: { [key: string]: number }, title: (key: string) => string, order: string[]): string {
  const keys = Object.keys(counts).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return keys
    .map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(title(key))} (${counts[key]})</option>`)
    .join('');
}

function renderFilters(c: Catalogue): string {
  const categories = optionsHtml(tally(c.entries.map((e) => e.category)), categoryTitle, Object.keys(categoryTitles));
  const risks = optionsHtml(tally(c.entries.map((e) => e.risk)), riskTitle, Object.keys(riskTitles));
  return `<form class="filters" role="search" aria-label="Поиск и фильтры правил" onsubmit="return false"><label for="search">Поиск по названию, фразе или инструменту<input id="search" type="search" autocomplete="off" placeholder="Например: удалить, контакт, get_events"></label><label for="category">Категория<select id="category"><option value="">Все категории</option>${categories}</select></label><label for="risk">Уровень риска<select id="risk"><option value="">Все уровни</option>${risks}</select></label></form>`;
}

function renderLineageTableHtml(c: Catalogue): string {
  const titles = new Map(c.entries.map((entry) => [entry.name, entry.title]));
  const rank = (d: Disposition) => DISPOSITIONS.indexOf(d);
  const rows = [...c.lineage.source.entries]
    .sort((a, b) => rank(a.disposition) - rank(b.disposition) || a.oldKey.localeCompare(b.oldKey))
    .map((e) => {
      const target = e.target
        ? `<a href="#${escapeHtml(e.target)}">${escapeHtml(titles.get(e.target) ?? e.target)}</a>`
        : 'нет замены';
      return `<tr><td><code>${escapeHtml(e.oldKey)}</code></td><td>${escapeHtml(e.oldTitle)}</td><td>${escapeHtml(dispositionTitles[e.disposition])}</td><td>${target}</td><td>${escapeHtml(e.reason)}</td></tr>`;
    })
    .join('');
  return `<div class="scroll"><table><caption class="sr">Прежние правила из исходников и их судьба</caption><thead><tr><th scope="col">Прежний ключ</th><th scope="col">Прежний заголовок</th><th scope="col">Что стало</th><th scope="col">Новое правило</th><th scope="col">Причина (текст из исходника, по-английски)</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderDatabaseCohortHtml(c: Catalogue): string {
  const db = c.lineage.database;
  if (!db.provided)
    return `<h3>Когорта живой базы (учитывается отдельно)</h3><p>Санитизированный список правил из живой базы для этой сборки не предоставлен (<code>${LINEAGE_FILE}</code> отсутствует). Сравнения с базой здесь нет.</p>`;
  const rows = db.entries
    .map(
      (e) =>
        `<tr><td>${e.id}</td><td><code>${escapeHtml(e.oldKey)}</code></td><td>${escapeHtml(e.status)}</td><td>${escapeHtml(dispositionTitles[e.disposition])}</td><td>${e.target ? `<code>${escapeHtml(e.target)}</code>` : 'нет замены'}</td><td>${escapeHtml(e.previousTools.join(', ') || '—')}</td><td>${escapeHtml(e.reason)}</td></tr>`,
    )
    .join('');
  return `<h3>Когорта живой базы (учитывается отдельно)</h3><p>Правил, найденных в живой базе: <b>${db.total}</b> (слито ${db.merge}, переписано ${db.rewrite}, выведено ${db.retire}). Это другая группа, а не добавка к ${c.lineage.source.total} прежним правилам из исходников: числа не складываются. Записи содержат только обобщённый смысл, без текста сообщений и без идентификаторов пользователей.</p><details><summary>Таблица живой базы (${db.total})</summary><div class="scroll"><table><thead><tr><th scope="col">Номер</th><th scope="col">Прежний ключ</th><th scope="col">Статус</th><th scope="col">Что стало</th><th scope="col">Новое правило</th><th scope="col">Прежние инструменты</th><th scope="col">Причина</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function renderLineageHtml(c: Catalogue): string {
  const s = c.lineage.source;
  return `<section id="lineage" aria-labelledby="lineage-title"><h2 id="lineage-title">Происхождение: от прежних правил к единому сиду</h2><p>${escapeHtml(lineageSummary(c).replaceAll('**', ''))}</p><details><summary>Все прежние правила из исходников (${s.total})</summary>${renderLineageTableHtml(c)}</details>${renderDatabaseCohortHtml(c)}</section>`;
}

function renderMetrics(c: Catalogue): string {
  const s = c.lineage.source;
  const db = c.lineage.database;
  const metric = (value: number | string, label: string) => `<li><b>${value}</b>${escapeHtml(label)}</li>`;
  return `<ul class="metrics" aria-label="Сводка">${[
    metric(c.entries.length, 'правил в целевом сиде'),
    metric(new Set(c.entries.map((e) => e.category)).size, 'категорий'),
    metric(s.total, 'прежних правил из исходников'),
    metric(`${s.merge} / ${s.rewrite} / ${s.retire}`, 'слито / переписано / выведено'),
    metric(db.provided ? db.total : '—', 'прежних записей БД, отдельная группа'),
  ].join('')}</ul>`;
}

function renderHead(): string {
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HyperCalendar: правила интентов и движок</title><style>${HTML_STYLES}</style>`;
}

function renderHeader(c: Catalogue): string {
  return `<p class="brand">HyperCalendar</p><h1>Правила интентов: единый сид и движок</h1><p class="lead">Целевой набор из ${c.entries.length} правил, собранный из исходного кода. Правило распознаёт фразу, проверяет параметры и вызывает те же инструменты календаря, что доступны AI.</p><aside class="notice" role="note"><strong>Это целевой сид, а не отчёт о развёртывании.</strong> Страница строится из исходников и не видит базу. Установку подтверждает отдельная проверка живой базы: отпечаток <code>${c.fingerprint}</code> должен совпасть со значением в <code>intent_basis_manifest</code>. Ссылки: <a href="README.md">каталог для GitHub</a>, <a href="engine.md">описание движка</a>, <a href="catalogue.json">машиночитаемый каталог</a>, <a href="../intent-catalogue.md">заметки по приватному отчёту</a>.</aside>${renderMetrics(c)}<nav class="jump" aria-label="Разделы страницы"><a href="#engine">Движок</a><a href="#catalogue">Каталог правил</a><a href="#lineage">Происхождение</a></nav>`;
}

export function renderHtml(c: Catalogue, engine: string = readEngineMarkdown()): string {
  const cards = groupByCategory(c.entries)
    .flatMap((group) => group.entries)
    .map(renderCard)
    .join('\n');
  const total = c.entries.length;
  return `<!doctype html><html lang="ru"><head>${renderHead()}</head><body><a class="skip" href="#catalogue">Перейти к каталогу</a><main>${renderHeader(c)}<section id="engine" aria-label="Описание движка">${renderEngineHtml(engine)}${renderBindingTypesHtml(c)}</section><section id="catalogue" aria-labelledby="catalogue-title"><h2 id="catalogue-title">Каталог правил</h2>${renderFilters(c)}<p id="count" role="status" aria-live="polite">Показано: ${total} из ${total}</p><p id="empty" hidden>Ничего не найдено. Измени запрос или сбрось фильтры.</p><div class="grid">${cards}</div></section>${renderLineageHtml(c)}<footer>Отпечаток целевого сида: <code>${c.fingerprint}</code><br>Пересборка: <code>bun run docs:intents</code>; проверка: <code>bun run docs:intents:check</code>. ${escapeHtml(CORPUS_NOTE)} Идентификаторов Telegram и текста переписок здесь нет.</footer></main><script>${HTML_SCRIPT}</script></body></html>\n`;
}

// ─── output ─────────────────────────────────────────────────────────────────

export function generatedFiles(source: CatalogueSource = currentSource(), engine: string = readEngineMarkdown()) {
  const c = buildCatalogue(source);
  return {
    'README.md': renderMarkdown(c),
    'index.html': renderHtml(c, engine),
    'catalogue.json': `${JSON.stringify(c, null, 2)}\n`,
  };
}

export function checkGeneratedFiles(directory: string): void {
  for (const [name, data] of Object.entries(generatedFiles())) {
    if (readFileSync(resolve(directory, name), 'utf8') !== data)
      throw new Error(`Generated docs stale: ${name}; run bun run docs:intents`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((x) => x !== '--check')) throw new Error('Usage: bun run docs:intents [--check]');
  if (args.includes('--check')) {
    checkGeneratedFiles(DOCS_DIRECTORY);
    console.log('Intent SSG is current');
  } else {
    mkdirSync(DOCS_DIRECTORY, { recursive: true });
    for (const [name, data] of Object.entries(generatedFiles())) writeFileSync(resolve(DOCS_DIRECTORY, name), data);
    console.log('Generated docs/intents: Markdown, HTML, JSON');
  }
}

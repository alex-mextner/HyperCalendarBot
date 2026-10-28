/** Text building blocks shared by the Markdown and HTML renderers: escaping, code spans and step descriptions. */
import type { Binding } from '../src/services/intent/workflow-bindings.ts';
import type { WorkflowInputValue } from '../src/services/intent/workflow-input.ts';
import { type I18nMap, type Level2Step, WorkflowSchema } from '../src/services/intent/workflow-schema.ts';
import type { CatalogueEntry } from './intent-doc-catalogue.ts';
import { bindingTypeTitles, categoryTitles, riskTitles } from './intent-doc-labels.ts';

// ─── escaping and text segments ─────────────────────────────────────────────

const HTML_ESCAPES: { [char: string]: string } = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (value: unknown): string =>
  String(value ?? '—').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);

const MARKDOWN_ESCAPES: { [char: string]: string } = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  ...Object.fromEntries([...'[]()`|*_\\~!#'].map((char) => [char, `&#${char.charCodeAt(0)};`])),
};

/**
 * Text for Markdown: markup characters and Markdown controls written as entities, in a single pass so an inserted
 * entity is never rescanned. Quotes stay literal: they are inert in Markdown text, and `what's` stays readable raw.
 */
export const escapeMarkdown = (value: unknown): string =>
  String(value ?? '—')
    .replace(/[&<>[\]()`|*_\\~!#]/g, (char) => MARKDOWN_ESCAPES[char]!)
    .replace(/\r?\n/g, '<br>');

/** Physical lines of a text file as the size gate counts them: a trailing newline does not add one. */
export const lineCount = (text: string): number => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

function longestRun(text: string, char: string): number {
  return Math.max(0, ...(text.match(new RegExp(`${char}+`, 'g')) ?? []).map((run) => run.length));
}

export function codeSpan(text: string): string {
  const flat = text.replace(/\r?\n/g, ' ');
  const fence = '`'.repeat(longestRun(flat, '`') + 1);
  return `${fence} ${flat} ${fence}`;
}

export function codeBlock(text: string, language: string): string {
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

export interface Segment {
  text: string;
  code?: boolean;
}
const say = (text: string): Segment => ({ text });
const lit = (text: string): Segment => ({ text, code: true });
export const markdownOf = (segments: Segment[]): string =>
  segments.map((s) => (s.code ? codeSpan(s.text) : escapeMarkdown(s.text))).join('');
export const htmlOf = (segments: Segment[]): string =>
  segments.map((s) => (s.code ? `<code>${escapeHtml(s.text)}</code>` : escapeHtml(s.text))).join('');

// ─── workflow descriptions ──────────────────────────────────────────────────

export interface WorkflowView {
  bindings: [string, Binding][];
  steps: Level2Step[];
  ru: { [key: string]: string };
}

export function viewOf(workflow: object): WorkflowView {
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

export function describeStep(step: Level2Step, ru: { [key: string]: string }): Segment[] {
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

export function describeBinding(name: string, binding: Binding): Segment[] {
  const type = String(binding.type);
  const segments = [lit(name), say(` — ${bindingTypeTitles[type] ?? type}`)];
  for (const [key, value] of Object.entries<unknown>(binding)) {
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

export function groupByCategory(entries: readonly CatalogueEntry[]): { category: string; entries: CatalogueEntry[] }[] {
  const order = Object.keys(categoryTitles);
  const categories = [...new Set(entries.map((entry) => entry.category))].sort(
    (a, b) => (order.indexOf(a) + 1 || order.length + 1) - (order.indexOf(b) + 1 || order.length + 1),
  );
  return categories.map((category) => ({ category, entries: entries.filter((entry) => entry.category === category) }));
}

export const categoryTitle = (category: string): string => categoryTitles[category] ?? category;
export const riskTitle = (risk: string): string => riskTitles[risk] ?? risk;

export function checkSummary(entry: CatalogueEntry): string {
  const total = entry.matching.length;
  if (entry.issues.length) return `Требует внимания: ${entry.issues.join(', ')}.`;
  const negatives = entry.negativeMatching.length;
  return `Все ${total} положительных примеров ведут в это правило, все ${negatives} отрицательных уходят к AI. Это проверка маршрутизации при сборке, а не приёмка на живом боте.`;
}

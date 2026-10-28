// Mechanical subset of docs/intents/response-quality.md: the findings a script can decide from the delivered text
// alone. A conversation passes the rubric when no hard finding is raised; soft findings are reported, never counted.
import { TZDate } from '@date-fns/tz';
import type { Anchor } from './anchor.ts';
import type { Conversation } from './history.ts';
import type { Expected, WorldEventView } from './oracle.ts';
import type { BotMessage, TurnObservation } from './world.ts';

export interface Finding {
  code: string;
  detail: string;
  soft: boolean;
}

const GENERIC =
  /no events found in this range|событий в этом диапазоне не найдено|in this range|в этом диапазоне|no data found|no results found/i;
const INTERNAL =
  /event_id|tool_outputs|bind\.|\{\{|\}\}|\bundefined\b|\bnull\b|\bNaN\b|\[object|basis\.|intent_|canonical_|workflow|\bscope\b|stepResults|true\/false/i;
const EMPTY =
  /нет событий|ничего не|пока нет|не найден|не нашёл|не нашел|пусто|нет ближайших|нет праздников|нет напоминаний|нет контактов|не найдено|no events|nothing|no upcoming|not found|no matching|no reminders|no contacts|no holidays|no results|empty|don't have any|do not have any/i;
const MONTH =
  /января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
const NUMERIC_DATE = /\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b/;
const PERIOD_WORD =
  /сегодня|завтра|послезавтра|вчера|недел|месяц|выходн|понедельник|вторник|сред[ау]|четверг|пятниц|суббот|воскресень|today|tomorrow|week|month|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i;
const CALENDAR_NAMED = /календар|calendar|групп|group|личн|personal|\bmy\b|твоём|вашем|your/i;
const DONE =
  /создан|добавлен|перенес|перенёс|удал|переименов|измен|отлож|сдвин|скрыт|приват|напоминан|приглаш|сохран|установ|обновл|отправ|поставлен|отмен|готово|created|added|moved|rescheduled|deleted|removed|renamed|changed|updated|snoozed|hidden|private|reminder|invit|saved|\bset\b|sent|done/i;
const TOOL_ERROR =
  /Invalid input|Tool execution failed|Unknown tool|not configured|\bis required\b|\bschema\b|Error:|failed to |not available|unavailable|cannot be|Unauthorized|permission denied/i;

const letters = (pattern: RegExp, text: string): number => (text.match(pattern) ?? []).length;

/** Text with the user's own words, world names, URLs, commands and zone names removed, for language detection. */
function foreignScan(
  message: string,
  userText: string,
  names: readonly string[],
): { cyrillic: number; latinWords: number } {
  let rest = message;
  for (const name of [...names].sort((a, b) => b.length - a.length)) rest = rest.split(name).join(' ');
  for (const word of userText.match(/[\p{L}\p{N}_]{3,}/gu) ?? []) rest = rest.split(word).join(' ');
  rest = rest
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\/[a-z_]+/g, ' ')
    .replace(/[A-Za-z]+\/[A-Za-z_]+/g, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/\b(UTC|GMT|AM|PM|am|pm|ID|id|OK|PNG|Telegram|Google|Calendar)\b/g, ' ');
  return { cyrillic: letters(/[А-Яа-яЁё]/g, rest), latinWords: letters(/[A-Za-z]{2,}/g, rest) };
}

const hhmm = (ms: number, tz: string): string => {
  const local = new TZDate(ms, tz);
  return `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
};

export interface RubricInput {
  conversation: Conversation;
  anchor: Anchor;
  expected: Extract<Expected, { kind: 'rule' }>;
  userTexts: string[];
  turns: TurnObservation[];
  worldEvents: readonly WorldEventView[];
  isWrite: boolean;
}

const finding = (code: string, detail: string, soft = false): Finding => ({ code, detail: detail.slice(0, 140), soft });

function shapeFindings(text: string, userText: string): Finding[] {
  const found: Finding[] = [];
  if (GENERIC.test(text)) found.push(finding('GENERIC_WORDING', text));
  if (/^\s*[[{]/.test(text) || /"[a-z_]+"\s*:\s*/.test(text)) found.push(finding('RAW_JSON', text));
  if (/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}Z\b|\+00:00\b|\b\d{2}:\d{2}Z\b|start_utc/.test(text))
    found.push(finding('RAW_ISO_DATETIME', text));
  const isoDates = text.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if (isoDates) found.push(finding('RAW_ISO_DATE', isoDates.join(','), userText.includes(isoDates[0] ?? '#')));
  const internal = INTERNAL.exec(text);
  if (internal) found.push(finding('INTERNAL_TOKEN', internal[0]));
  return found;
}

function languageFindings(
  text: string,
  userText: string,
  lang: Conversation['lang'],
  names: readonly string[],
): Finding[] {
  const found: Finding[] = [];
  const foreign = foreignScan(text, userText, names);
  if (lang === 'ru' && foreign.latinWords >= 3) found.push(finding('LANG_EN_IN_RU', text));
  if (lang === 'en' && foreign.cyrillic >= 3) found.push(finding('LANG_RU_IN_EN', text));
  if (lang === 'ru' && TOOL_ERROR.test(text) && foreign.latinWords >= 2)
    found.push(finding('RAW_TOOL_ERROR_IN_RU', text));
  return found;
}

/** A listed event's clock time must be the user's local time, not the stored UTC one. */
function localTimeFindings(text: string, worldEvents: readonly WorldEventView[], tz: string): Finding[] {
  const found: Finding[] = [];
  for (const line of text.split('\n')) {
    for (const event of worldEvents) {
      if (!line.includes(event.title)) continue;
      const tokens = (line.match(/\b\d{1,2}:\d{2}\b/g) ?? []).map((token) => token.padStart(5, '0'));
      const utc = `${String(new Date(event.startMs).getUTCHours()).padStart(2, '0')}:${String(new Date(event.startMs).getUTCMinutes()).padStart(2, '0')}`;
      const local = hhmm(event.startMs, tz);
      if (tokens.length > 0 && !tokens.includes(local) && tokens.includes(utc) && utc !== local)
        found.push(finding('UTC_SHOWN_AS_LOCAL', `${event.title}: ${utc} vs ${local}`));
    }
  }
  return found;
}

function messageFindings(message: BotMessage, input: RubricInput, names: readonly string[]): Finding[] {
  const { conversation, anchor, userTexts, worldEvents } = input;
  const { text } = message;
  const userText = userTexts.join(' ');
  return [
    ...shapeFindings(text, userText),
    ...languageFindings(text, userText, conversation.lang, names),
    ...(input.isWrite ? [] : localTimeFindings(text, worldEvents, anchor.tz)),
  ];
}

const EMPTY_CHECKED_FAMILIES: readonly string[] = ['calendar.day', 'calendar.period', 'calendar.count', 'slots.day'];

function readFindings(first: TurnObservation, family: string): Finding[] {
  const reply = first.messages.map((message) => message.text).join('\n');
  const calls = first.tools.filter((call) => !call.mutation);
  const failed = calls.some((call) => !call.ok);
  if (failed && EMPTY.test(reply)) return [finding('READ_FAILURE_AS_EMPTY', reply)];
  if (failed || calls.length === 0 || !EMPTY.test(reply) || !EMPTY_CHECKED_FAMILIES.includes(family)) return [];
  const found: Finding[] = [];
  if (!(MONTH.test(reply) || NUMERIC_DATE.test(reply) || PERIOD_WORD.test(reply)))
    found.push(finding('EMPTY_NO_CHECKED_DAY', reply));
  if (!CALENDAR_NAMED.test(reply)) found.push(finding('EMPTY_NO_CALENDAR', reply));
  return found;
}

function writeFindings(first: TurnObservation, input: RubricInput): Finding[] {
  const found: Finding[] = [];
  const prompt = first.messages.map((message) => message.text).join('\n');
  if (prompt.trim().length === 0) found.push(finding('CONFIRM_EMPTY', ''));
  if (input.expected.confirm === 'yes' && input.turns.length > 1) {
    const last = input.turns[input.turns.length - 1]?.messages.at(-1)?.text ?? '';
    if (!DONE.test(last)) found.push(finding('RESULT_DOES_NOT_SAY_WHAT_WAS_DONE', last));
  }
  return found;
}

export function rubricFindings(input: RubricInput): Finding[] {
  const names = [
    ...input.worldEvents.map((event) => event.title),
    'Иван',
    'Anna',
    'Анна',
    'Ivan',
    'Standup',
    'Лена',
    'Lena',
    'Марк',
    'Mark',
  ];
  const found = input.turns
    .flatMap((turn) => turn.messages)
    .flatMap((message) => messageFindings(message, input, names));
  const first = input.turns[0];
  if (!first) return found;
  return [...found, ...(input.isWrite ? writeFindings(first, input) : readFindings(first, input.expected.family))];
}

export const hardFindings = (findings: readonly Finding[]): Finding[] => findings.filter((finding) => !finding.soft);

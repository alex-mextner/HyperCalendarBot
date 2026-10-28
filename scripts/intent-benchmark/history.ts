// Model history: the labelled, synthetic conversations the intent benchmark runs on. Labels are what a careful
// annotator reads from the message (family, slots, whether the AI is the right handler); they are never computed
// by the production parser, so a parser change cannot rewrite its own answer key.
import { TZDate } from '@date-fns/tz';
import { z } from 'zod';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const ZONES = [
  'UTC',
  'Europe/Belgrade',
  'America/New_York',
  'Pacific/Auckland',
  'Asia/Kolkata',
  'Pacific/Kiritimati',
] as const;

export const STYLES = [
  'plain',
  'terse',
  'typo',
  'no_punct',
  'trailing_punct',
  'polite',
  'slang',
  'mixed_lang',
  'long',
  'verbless',
  'caps',
] as const;

const Weekday = z.enum(WEEKDAYS);
const DaySlot = z.union([
  z.strictObject({ rel: z.number().int().min(-30).max(400) }),
  z.strictObject({ weekday: Weekday }),
]);
const HourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const PositiveInt = z.number().int().positive().max(100000);
const Ref = z.union([z.strictObject({ id: PositiveInt }), z.strictObject({ title: z.string().min(1).max(120) })]);
const Title = z.string().min(1).max(200);
const TitleAlt = z.array(Title).max(8).optional();
const Period = z.enum(['today', 'tomorrow', 'week', 'next_week', 'month', 'next_month', 'weekend']);
const Username = z.string().regex(/^@[A-Za-z0-9_]{5,32}$/);

/** Slot shape of each family; the key set is the family list of families.json. */
export const FamilySlots = {
  'calendar.day': z.strictObject({ day: DaySlot }),
  'calendar.period': z.strictObject({ period: Period }),
  'calendar.upcoming': z.strictObject({ limit: PositiveInt.max(20).optional() }),
  'calendar.search': z.strictObject({ query: Title }),
  'calendar.when': z.strictObject({ query: Title }),
  'calendar.count': z.strictObject({ period: Period }),
  'calendar.image': z.strictObject({ period: Period }),
  'slots.day': z.strictObject({ day: DaySlot }),
  'slots.check_time': z.strictObject({ day: DaySlot, time: HourMinute }),
  'holidays.upcoming': z.strictObject({}),
  'event.show': z.strictObject({ ref: Ref }),
  'event.create': z.strictObject({
    title: Title,
    titleAlt: TitleAlt,
    day: DaySlot,
    time: HourMinute,
    duration: PositiveInt.max(1440).optional(),
  }),
  'event.create_range': z.strictObject({
    title: Title,
    titleAlt: TitleAlt,
    day: DaySlot,
    time: HourMinute,
    endTime: HourMinute,
  }),
  'event.create_invite': z.strictObject({
    title: Title,
    titleAlt: TitleAlt,
    day: DaySlot,
    time: HourMinute,
    invitee: Username,
  }),
  'reminder.after': z.strictObject({ text: Title, textAlt: TitleAlt, minutes: PositiveInt.max(10080) }),
  'event.delete': z.strictObject({ ref: Ref }),
  'event.reschedule': z.strictObject({ ref: Ref, day: DaySlot.optional(), time: HourMinute.optional() }),
  'event.rename': z.strictObject({ ref: Ref, title: Title, titleAlt: TitleAlt }),
  'event.set_detail': z.strictObject({
    ref: Ref,
    field: z.enum(['location', 'description']),
    value: z.string().min(1).max(300),
  }),
  'event.snooze': z.strictObject({ ref: Ref, minutes: PositiveInt.max(1440) }),
  'event.hide': z.strictObject({ ref: Ref }),
  'reminder.set': z.strictObject({ ref: Ref, minutes: PositiveInt.max(10080) }),
  'reminder.clear': z.strictObject({ ref: Ref }),
  'reminder.list': z.strictObject({ ref: Ref }),
  'invite.send': z.strictObject({ ref: Ref, invitee: Username }),
  'invite.status': z.strictObject({ ref: Ref }),
  'contacts.list': z.strictObject({}),
  'contacts.find': z.strictObject({ name: Title }),
  'settings.view': z.strictObject({}),
  'time.now': z.strictObject({ place: Title.optional() }),
  'calc.evaluate': z.strictObject({ expression: Title }),
  'bot.info': z.strictObject({}),
  'google.status': z.strictObject({}),
} as const;

export type FamilyId = keyof typeof FamilySlots;
export const FAMILY_IDS = Object.keys(FamilySlots) as FamilyId[];

export const AI_REASONS = [
  'bare_hour',
  'missing_slot',
  'ambiguous_day',
  'bulk',
  'multi_request',
  'recurrence',
  'negation_or_quote',
  'advice_or_analysis',
  'chitchat',
  'past_or_invalid',
  'unsupported',
] as const;
export type AiReason = (typeof AI_REASONS)[number];

const ruleExpectations: z.ZodType[] = FAMILY_IDS.map((family) =>
  z.strictObject({
    route: z.literal('rule'),
    family: z.literal(family),
    slots: FamilySlots[family],
    /** What the user does at the confirmation question: 'yes' (default for writes) or 'no'. */
    confirm: z.enum(['yes', 'no']).optional(),
  }),
);
const RuleExpectation = z.union(ruleExpectations as [z.ZodType, z.ZodType, ...z.ZodType[]]);

const AiExpectation = z.strictObject({
  route: z.literal('ai'),
  why: z.enum(AI_REASONS),
  /** True when the message is a calendar request a person would call intent-like; false for chit-chat. */
  intentLike: z.boolean(),
});

export const SeedEventSchema = z.strictObject({
  /** The event number a message names ("#643"); absent, the calendar assigns the next free one. */
  id: PositiveInt.optional(),
  title: z.string().min(1).max(120),
  /** Local days after the clock's today. */
  dayOffset: z.number().int().min(-30).max(400),
  at: HourMinute,
  durationMin: PositiveInt.max(1440),
});
export type SeedEvent = z.infer<typeof SeedEventSchema>;

/** Where a real-history conversation came from; never present on the synthetic model history. */
export const RealMetaSchema = z.strictObject({
  /** Pseudonymous user label (u01…); the split is stratified by it. */
  user: z.string().regex(/^u\d{2}$/),
  /** `confirmed` labels count in precision claims; `unclear` ones are kept for coverage analysis only. */
  status: z.enum(['confirmed', 'unclear']),
  /** What the historical system did relative to the request. */
  historical: z.enum(['agrees', 'disagrees', 'unclear', 'none']),
  /** Messages the owner's own QA probes produced; excluded from every KPI. */
  qaProbe: z.boolean(),
});
export type RealMeta = z.infer<typeof RealMetaSchema>;

export const ConversationSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9-]{3,40}$/)
    .optional(),
  lang: z.enum(['ru', 'en']),
  chat: z.enum(['private', 'group']),
  tz: z.enum(ZONES),
  clock: z.strictObject({ day: Weekday, at: HourMinute }),
  /** A real calendar day (YYYY-MM-DD) the clock is set to; synthetic conversations use the fixed benchmark week. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  world: z.enum(['rich', 'empty']),
  /** Extra events of this conversation's calendar (real history: the events the message talks about). */
  seedEvents: z.array(SeedEventSchema).max(6).optional(),
  styles: z.array(z.enum(STYLES)).max(4).optional(),
  say: z.string().min(1).max(1500),
  // biome-ignore lint/suspicious/noThenProperty: wire-format key of the authored JSONL; plain data, never awaited as a thenable
  then: z.array(z.string().min(1).max(200)).max(3).optional(),
  expect: z.union([RuleExpectation, AiExpectation]),
  real: RealMetaSchema.optional(),
});

export type Conversation = Omit<z.infer<typeof ConversationSchema>, 'expect'> & {
  expect: RuleExpect | AiExpect;
};
export interface RuleExpect {
  route: 'rule';
  family: FamilyId;
  slots: { [slot: string]: unknown };
  confirm?: 'yes' | 'no';
}
export interface AiExpect {
  route: 'ai';
  why: AiReason;
  intentLike: boolean;
}

export function parseConversationLine(line: string): Conversation {
  return ConversationSchema.parse(JSON.parse(line)) as Conversation;
}

// ─── placeholders in message text ────────────────────────────────────────────

const RU_MONTH_GEN = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
const EN_MONTH = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface LocalDay {
  y: number;
  m: number;
  d: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function shiftDay(day: LocalDay, delta: number): LocalDay {
  const moved = new Date(Date.UTC(day.y, day.m - 1, day.d + delta));
  return { y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: moved.getUTCDate() };
}

export const isoOf = (day: LocalDay): string => `${String(day.y).padStart(4, '0')}-${pad2(day.m)}-${pad2(day.d)}`;

/** `{d+9:ru}` → "19 октября" for a day nine days after the clock's local today. Unknown formats throw. */
export function expandPlaceholders(text: string, today: LocalDay): string {
  return text.replace(/\{d([+-]\d{1,3}):(ru|en|iso|dmy|dm)\}/g, (_whole, offset: string, format: string) => {
    const day = shiftDay(today, Number(offset));
    switch (format) {
      case 'ru':
        return `${day.d} ${RU_MONTH_GEN[day.m - 1]}`;
      case 'en':
        return `${EN_MONTH[day.m - 1]} ${day.d}`;
      case 'iso':
        return isoOf(day);
      case 'dmy':
        return `${pad2(day.d)}.${pad2(day.m)}.${day.y}`;
      default:
        return `${pad2(day.d)}.${pad2(day.m)}`;
    }
  });
}

export function hasUnexpandedPlaceholder(text: string): boolean {
  return /\{d[^}]*\}/.test(text);
}

/** Local calendar day of an instant in an IANA zone. */
export function localDayOf(instantMs: number, tz: string): LocalDay {
  const local = new TZDate(instantMs, tz);
  return { y: local.getFullYear(), m: local.getMonth() + 1, d: local.getDate() };
}

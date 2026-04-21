import type { Lang } from '../../config/constants.ts';
import { t } from '../../config/constants.ts';
import type { CalendarEvent } from '../../database/types.ts';

export interface EventFieldSnapshot {
  title: string;
  description: string | null;
  start_at: string;
  end_at: string | null;
  all_day: boolean;
  timezone: string;
  location: string | null;
  recurrence_rule: string | null;
}

export type SharedField = 'title' | 'description' | 'start_at' | 'end_at' | 'all_day' | 'location' | 'recurrence_rule';
export type PersonalField = 'timezone';
export type TrackedField = SharedField | PersonalField;

export interface FieldChange {
  field: TrackedField;
  oldValue: string | boolean | null;
  newValue: string | boolean | null;
}

const SHARED_FIELDS: readonly SharedField[] = [
  'title',
  'description',
  'start_at',
  'end_at',
  'all_day',
  'location',
  'recurrence_rule',
];

const PERSONAL_FIELDS: readonly PersonalField[] = ['timezone'];

const ALL_TRACKED: readonly TrackedField[] = [...SHARED_FIELDS, ...PERSONAL_FIELDS];

const FORMAT_ORDER: readonly TrackedField[] = [
  'start_at',
  'end_at',
  'location',
  'title',
  'description',
  'all_day',
  'recurrence_rule',
];

export interface LocalEventFromGoogleSnapshot {
  title: string;
  description: string | null;
  start_at: string;
  end_at: string | null;
  all_day: boolean;
  timezone: string;
  location: string | null;
  recurrence_rule: string | null;
}

export function snapshotFromCalendarEvent(
  e: Pick<
    CalendarEvent,
    'title' | 'description' | 'start_at' | 'end_at' | 'all_day' | 'timezone' | 'location' | 'recurrence_rule'
  >,
): EventFieldSnapshot {
  return {
    title: e.title,
    description: e.description,
    start_at: e.start_at,
    end_at: e.end_at,
    all_day: e.all_day === 1,
    timezone: e.timezone,
    location: e.location,
    recurrence_rule: e.recurrence_rule,
  };
}

export function snapshotFromGoogleLocal(e: LocalEventFromGoogleSnapshot): EventFieldSnapshot {
  return {
    title: e.title,
    description: e.description,
    start_at: e.start_at,
    end_at: e.end_at,
    all_day: Boolean(e.all_day),
    timezone: e.timezone,
    location: e.location,
    recurrence_rule: e.recurrence_rule,
  };
}

function normalizeStringField(val: string | boolean | null): string | null {
  if (typeof val === 'boolean') return null;
  if (val === null || val === undefined) return null;
  const trimmed = val.trim();
  return trimmed === '' ? null : trimmed;
}

function valuesEqual(a: string | boolean | null, b: string | boolean | null, field: TrackedField): boolean {
  if (field === 'all_day') {
    return Boolean(a) === Boolean(b);
  }
  const na = normalizeStringField(a);
  const nb = normalizeStringField(b);
  return na === nb;
}

export function computeEventDiff(existing: EventFieldSnapshot, incoming: EventFieldSnapshot): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of ALL_TRACKED) {
    const oldVal = existing[field] as string | boolean | null;
    const newVal = incoming[field] as string | boolean | null;
    if (!valuesEqual(oldVal, newVal, field)) {
      changes.push({ field, oldValue: oldVal, newValue: newVal });
    }
  }
  return changes;
}

export function getSharedChanges(changes: FieldChange[]): FieldChange[] {
  return changes.filter((c) => (SHARED_FIELDS as readonly string[]).includes(c.field));
}

export function getPersonalChanges(changes: FieldChange[]): FieldChange[] {
  return changes.filter((c) => (PERSONAL_FIELDS as readonly string[]).includes(c.field));
}

export function hasTimeChange(changes: FieldChange[]): boolean {
  return changes.some((c) => c.field === 'start_at' || c.field === 'end_at' || c.field === 'all_day');
}

function formatSingleChange(change: FieldChange, lang: Lang): string {
  const msgs = t(lang).sync;
  switch (change.field) {
    case 'start_at':
    case 'end_at':
      return msgs.changeTime(String(change.oldValue ?? ''), String(change.newValue ?? ''));
    case 'title':
      return msgs.changeTitle(String(change.oldValue ?? ''), String(change.newValue ?? ''));
    case 'location':
      return msgs.changeLocation(String(change.oldValue ?? ''), String(change.newValue ?? ''));
    case 'description':
      return msgs.changeDescription;
    case 'all_day':
      return msgs.changeAllDay(Boolean(change.newValue));
    case 'recurrence_rule':
      return msgs.changeRecurrence;
    default:
      return '';
  }
}

export function formatChanges(changes: FieldChange[], lang: Lang): string {
  const sorted = [...changes].sort((a, b) => {
    const ai = FORMAT_ORDER.indexOf(a.field);
    const bi = FORMAT_ORDER.indexOf(b.field);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const change of sorted) {
    if (change.field === 'timezone') continue;
    if (change.field === 'end_at' && seen.has('start_at')) continue;
    seen.add(change.field);
    const line = formatSingleChange(change, lang);
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

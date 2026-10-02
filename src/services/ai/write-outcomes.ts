/** Run-local mutation evidence. This helper never executes or recovers actions. */
import { normalizeNumericId } from './numeric-id.ts';
import type { ExecutorDisposition } from './tool-executor.ts';

const targets = {
  delete_event: ['event_id'],
  update_event: ['event_id'],
  send_invitation: ['event_id', 'invitee_id', 'invitee_username'],
} satisfies { [operation: string]: string[] };
const updateFields = ['title', 'start_at', 'end_at', 'description', 'location', 'location_abstract', 'recurrence_rule'];
const labels: { [operation: string]: [string, string] } = {
  delete_event: ['Delete event', 'Удаление события'],
  update_event: ['Update event', 'Изменение события'],
  create_event: ['Create event', 'Создание события'],
  send_invitation: ['Send invitation', 'Отправка приглашения'],
};
const fieldLabels: { [field: string]: [string, string] } = {
  title: ['title', 'название'],
  start_at: ['start time', 'начало'],
  end_at: ['end time', 'окончание'],
  description: ['description', 'описание'],
  location: ['location', 'место'],
  all_day: ['all day', 'весь день'],
  location_abstract: ['location type', 'тип места'],
  recurrence_rule: ['recurrence', 'повторение'],
};
type Reason = 'permission' | 'missing' | 'invalid' | 'failed' | 'skipped';
const reasons: { [reason in Reason]: [string, string] } = {
  permission: ['permission denied', 'нет доступа'],
  missing: ['target not found', 'объект не найден'],
  skipped: ['skipped; no new write executed', 'пропущено; новое изменение не выполнялось'],
  invalid: ['invalid request', 'некорректный запрос'],
  failed: ['operation failed', 'операция не выполнена'],
};
function reasonFor(error: string | undefined): Reason {
  if (/not owner|permission|access|forbidden/i.test(error ?? '')) return 'permission';
  if (/not found|does not exist/i.test(error ?? '')) return 'missing';
  if (/invalid|validation|past_event/i.test(error ?? '')) return 'invalid';
  return 'failed';
}
function isTargetOperation(operation: string): operation is keyof typeof targets {
  return Object.hasOwn(targets, operation);
}
function safeId(value: unknown): string | null {
  const id = normalizeNumericId(value);
  return typeof id === 'number' && Number.isSafeInteger(id) ? `#${id}` : null;
}

export class WriteOutcomes {
  private readonly outcomes = new Map<
    string,
    {
      operation: string;
      target: string;
      field?: string;
      success: boolean;
      reason: Reason;
    }
  >();

  constructor(private readonly writes: ReadonlySet<string> = new Set(Object.keys(targets))) {}

  record(
    operation: string,
    input: unknown,
    result: {
      success: boolean;
      error?: string;
      disposition: ExecutorDisposition;
    },
  ): void {
    if (!this.writes.has(operation) || result.disposition === 'waiting') return;
    const fields = typeof input === 'object' && input !== null ? input : {};
    const targetFields = isTargetOperation(operation) ? targets[operation] : Object.keys(fields).sort();
    const identity = targetFields.map((field) => {
      if (field === 'invitee_username' && Reflect.get(fields, 'invitee_id') !== undefined) return [field, undefined];
      const value: unknown = Reflect.get(fields, field);
      return [field, field.endsWith('_id') ? normalizeNumericId(value) : value];
    });
    // Only safe numeric identifiers are echoed; titles, usernames and provider text stay private.
    const target = ['event_id', 'invitee_id', 'id']
      .map((field) => safeId(Reflect.get(fields, field)))
      .filter((id) => id !== null)
      .join(' / ');
    const requested =
      operation === 'update_event' ? updateFields.filter((field) => Reflect.get(fields, field) !== undefined) : [];
    for (const field of requested.length ? requested : [undefined]) {
      const key = JSON.stringify([operation, identity, field]);
      if (result.disposition === 'skipped' && this.outcomes.has(key)) continue;
      this.outcomes.set(key, {
        operation,
        target,
        field,
        success: result.disposition === 'executed' && result.success,
        reason: result.disposition === 'skipped' ? 'skipped' : reasonFor(result.error),
      });
    }
  }

  finalNotice(language: string): string | null {
    if (![...this.outcomes.values()].some((outcome) => !outcome.success)) return null;
    const lang = language === 'ru' ? 1 : 0;
    return [...this.outcomes.values()]
      .map(({ operation, target, field, success, reason }) => {
        const status = lang ? (success ? 'Выполнено' : 'Не выполнено') : success ? 'Completed' : 'Not completed';
        const operationLabel = labels[operation]?.[lang] ?? (lang ? 'Изменение' : 'Write');
        const fieldLabel = field ? ` (${fieldLabels[field]?.[lang] ?? (lang ? 'поле' : 'field')})` : '';
        return `${status}: ${operationLabel}${target ? ` ${target}` : ''}${fieldLabel}${success ? '' : ` — ${reasons[reason][lang]}`}`;
      })
      .join('\n');
  }
}

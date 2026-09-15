/** Run-local mutation evidence. Receipts describe attempts, not durable operation intent. */
import { t, toLang } from '../../config/constants.ts';
import { EVENT_UPDATE_FIELDS } from '../../database/repositories/event.repository.ts';
import { normalizeNumericId } from './numeric-id.ts';
import { type ExecutorDisposition, isMutationTool } from './tool-executor.ts';
import type { ToolResult } from './types.ts';

const targets = {
  delete_event: ['event_id', 'scope', 'owner_id'],
  update_event: ['event_id', 'scope', 'owner_id'],
  send_invitation: ['event_id', 'invitee_id', 'invitee_username'],
} satisfies { [operation: string]: string[] };
const updateFields = [...EVENT_UPDATE_FIELDS, 'location_abstract'];
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
      disposition: ExecutorDisposition;
      mutationState?: ToolResult['mutationState'];
      effect?: ToolResult['effect'];
      attempt: number;
    }
  >();
  private attempts = 0;
  mayHaveMutated = false;
  speechQuestion = '';

  constructor(private readonly writes: ReadonlySet<string> = new Set(Object.keys(targets))) {}

  record(operation: string, input: unknown, result: ToolResult & { disposition: ExecutorDisposition }): void {
    if (result.awaitingInput?.kind === 'speech') this.speechQuestion = result.awaitingInput.question;
    if (result.mutationState === 'confirmed' || result.mutationState === 'uncertain') this.mayHaveMutated = true;
    if (!this.writes.has(operation) || !isMutationTool(operation, input) || result.disposition === 'waiting') return;
    const fields = typeof input === 'object' && input !== null ? input : {};
    const attempt = ++this.attempts;
    const identity = isTargetOperation(operation)
      ? targets[operation].map((field) => {
          if (field === 'invitee_username' && Reflect.get(fields, 'invitee_id') !== undefined)
            return [field, undefined];
          const value: unknown = Reflect.get(fields, field);
          return [field, field.endsWith('_id') ? normalizeNumericId(value) : value];
        })
      : attempt;
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
        attempt,
        success: result.disposition === 'executed' && result.success,
        disposition: result.disposition,
        mutationState: result.mutationState,
        effect: result.effect,
      });
    }
  }

  finalNotice(language: string, hideTargets = false, interrupted = false): string | null {
    const outcomes = [...this.outcomes.values()];
    if (
      !interrupted &&
      !outcomes.some((outcome) => !outcome.success || (outcome.effect && outcome.effect.kind !== 'event_deleted'))
    )
      return null;
    const tr = t(toLang(language)).writeOutcomes;
    const lines = outcomes.map(({ operation, target, field, success, disposition, mutationState, effect, attempt }) => {
      const label = Object.hasOwn(tr.operations, operation) ? Reflect.get(tr.operations, operation) : tr.write;
      const fieldLabel = field
        ? ` (${Object.hasOwn(tr.fields, field) ? Reflect.get(tr.fields, field) : tr.field})`
        : '';
      let detail: string;
      if (effect?.kind === 'invitation') {
        detail =
          effect.delivery === 'delivered'
            ? tr.invitationDelivered
            : effect.delivery === 'manual_forward'
              ? tr.invitationManual
              : tr.invitationFailed;
      } else if (effect?.kind === 'attendance_declined') {
        detail = tr.attendanceDeclined;
      } else {
        const status = success ? tr.completed : mutationState === 'uncertain' ? tr.uncertain : tr.notCompleted;
        const reason =
          disposition === 'skipped' ? tr.skipped : mutationState === 'not_applied' ? tr.notApplied : tr.failed;
        detail = `${status}: ${label}${!hideTargets && target ? ` ${target}` : ''}${fieldLabel}${success ? '' : ` — ${reason}`}`;
      }
      return `${tr.attempt(attempt)}: ${detail}`;
    });
    if (outcomes.length) lines.unshift(tr.attempts);
    if (interrupted) lines.push(tr.interrupted);
    return lines.join('\n') || null;
  }
}

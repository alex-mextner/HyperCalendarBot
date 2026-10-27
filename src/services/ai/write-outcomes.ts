/** Run-local mutation evidence. Receipts describe attempts, not durable operation intent. */
import { type Messages, t, toLang } from '../../config/constants.ts';
import { EVENT_UPDATE_FIELDS, UNRESOLVED_PLACE } from '../../database/repositories/event.repository.ts';
import { normalizeNumericId } from './numeric-id.ts';
import { DELIVERING_TOOLS, type ExecutorDisposition, isMutationTool, SILENT_TOOLS } from './tool-executor.ts';
import type { ToolResult } from './types.ts';

const targets = {
  delete_event: ['event_id', 'scope', 'owner_id'],
  update_event: ['event_id', 'scope', 'owner_id'],
  send_invitation: ['event_id', 'invitee_id', 'invitee_username'],
} satisfies { [operation: string]: string[] };
/** Fields update_event can change; the confirmed place is set only by the creator's tap or pin (#620). */
const updateFields = [...EVENT_UPDATE_FIELDS, 'location_abstract'].filter(
  (field) => !Object.hasOwn(UNRESOLVED_PLACE, field),
);
function isTargetOperation(operation: string): operation is keyof typeof targets {
  return Object.hasOwn(targets, operation);
}
function safeId(value: unknown): string | null {
  const id = normalizeNumericId(value);
  return typeof id === 'number' && Number.isSafeInteger(id) ? `#${id}` : null;
}

/**
 * What makes two calls the same write: the target fields of a target operation, normalized so an
 * id sent as "7" and as 7 collide. Any other write is distinct per attempt.
 */
function attemptIdentity(operation: string, fields: object, attempt: number): number | unknown[] {
  if (!isTargetOperation(operation)) return attempt;
  return targets[operation].map((field) => {
    if (field === 'invitee_username' && Reflect.get(fields, 'invitee_id') !== undefined) return [field, undefined];
    const value: unknown = Reflect.get(fields, field);
    return [field, field.endsWith('_id') ? normalizeNumericId(value) : value];
  });
}
/** The `#id / #id` tail of a receipt line, from whichever id fields the call carried. */
function targetLabel(fields: object): string {
  return ['event_id', 'invitee_id', 'id']
    .map((field) => safeId(Reflect.get(fields, field)))
    .filter((id) => id !== null)
    .join(' / ');
}
/** update_event is judged field by field; the fields the call actually set. */
function requestedUpdateFields(operation: string, fields: object): string[] {
  if (operation !== 'update_event') return [];
  return updateFields.filter((field) => Reflect.get(fields, field) !== undefined);
}

interface WriteOutcome {
  operation: string;
  target: string;
  field?: string;
  success: boolean;
  disposition: ExecutorDisposition;
  mutationState?: ToolResult['mutationState'];
  effect?: ToolResult['effect'];
  attempt: number;
}
type WriteOutcomeText = Messages['writeOutcomes'];

/** The receipt line for a write that carries a delivery or attendance effect; null for a plain write. */
function effectDetail(effect: WriteOutcome['effect'], tr: WriteOutcomeText): string | null {
  if (effect?.kind === 'invitation') {
    if (effect.delivery === 'delivered') return tr.invitationDelivered;
    return effect.delivery === 'manual_forward' ? tr.invitationManual : tr.invitationFailed;
  }
  if (effect?.kind === 'attendance_declined') return tr.attendanceDeclined;
  return null;
}
/** The receipt line for a plain write: status, operation, target, changed field, and why it did not land. */
function plainDetail(outcome: WriteOutcome, tr: WriteOutcomeText, hideTargets: boolean): string {
  const { operation, target, field, success, disposition, mutationState } = outcome;
  const label = Object.hasOwn(tr.operations, operation) ? Reflect.get(tr.operations, operation) : tr.write;
  const fieldLabel = field ? ` (${Object.hasOwn(tr.fields, field) ? Reflect.get(tr.fields, field) : tr.field})` : '';
  const status = success ? tr.completed : mutationState === 'uncertain' ? tr.uncertain : tr.notCompleted;
  const reason = disposition === 'skipped' ? tr.skipped : mutationState === 'not_applied' ? tr.notApplied : tr.failed;
  return `${status}: ${label}${!hideTargets && target ? ` ${target}` : ''}${fieldLabel}${success ? '' : ` — ${reason}`}`;
}

export class WriteOutcomes {
  private readonly outcomes = new Map<string, WriteOutcome>();
  private attempts = 0;
  mayHaveMutated = false;
  /** A rendered image reached the chat. */
  private delivered = false;
  /** A render was asked for but sent nothing: it failed, or the throttle skipped it. */
  private deliveryMissed = false;
  /** A silent answering tool (a reaction) reached the chat. */
  private reacted = false;
  speechQuestion = '';

  /**
   * The request was answered by a tool, so a silent final is fine: a picture arrived, or the
   * turn only reacted. A 👍 does not stand in for a picture that was asked for and never came.
   */
  get toolAnswered(): boolean {
    return this.delivered || (this.reacted && !this.deliveryMissed);
  }

  constructor(private readonly writes: ReadonlySet<string> = new Set(Object.keys(targets))) {}

  record(operation: string, input: unknown, result: ToolResult & { disposition: ExecutorDisposition }): void {
    this.noteTurnEffects(operation, result);
    if (!this.writes.has(operation) || !isMutationTool(operation, input) || result.disposition === 'waiting') return;
    const fields = typeof input === 'object' && input !== null ? input : {};
    const attempt = ++this.attempts;
    const identity = attemptIdentity(operation, fields, attempt);
    const target = targetLabel(fields);
    const requested = requestedUpdateFields(operation, fields);
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

  /** Run-wide flags a tool result sets whether or not it is a recorded write: speech question, mutation, delivery. */
  private noteTurnEffects(operation: string, result: ToolResult & { disposition: ExecutorDisposition }): void {
    if (result.awaitingInput?.kind === 'speech') this.speechQuestion = result.awaitingInput.question;
    if (result.mutationState === 'confirmed' || result.mutationState === 'uncertain') this.mayHaveMutated = true;
    const sent = result.disposition === 'executed' && result.success;
    if (DELIVERING_TOOLS.has(operation)) {
      if (sent) this.delivered = true;
      else this.deliveryMissed = true;
    } else if (SILENT_TOOLS.has(operation) && sent) this.reacted = true;
  }

  finalNotice(language: string, hideTargets = false, interrupted = false): string | null {
    const needsGuard = [...this.outcomes.values()].some(
      (outcome) =>
        !outcome.success ||
        outcome.effect?.kind === 'attendance_declined' ||
        (outcome.effect?.kind === 'invitation' && outcome.effect.delivery !== 'delivered'),
    );
    if (!interrupted && !needsGuard) return null;
    return this.describe(language, hideTargets, interrupted);
  }

  /** Every recorded write, clean successes included — for a turn the model left without an answer. */
  summary(language: string, hideTargets: boolean): string | null {
    return this.describe(language, hideTargets, false);
  }

  private describe(language: string, hideTargets: boolean, interrupted: boolean): string | null {
    const outcomes = [...this.outcomes.values()];
    // Attempt framing is useful only when something actually failed/skipped and
    // a later receipt may correct it. On a clean success (including an
    // interrupted run where writes already landed) it reads like internal debug
    // output and replaced the normal conversational answer in production.
    const frameAttempts = outcomes.some((outcome) => !outcome.success || outcome.disposition === 'skipped');
    const tr = t(toLang(language)).writeOutcomes;
    const lines = outcomes.map((outcome) => {
      const detail = effectDetail(outcome.effect, tr) ?? plainDetail(outcome, tr, hideTargets);
      return frameAttempts ? `${tr.attempt(outcome.attempt)}: ${detail}` : detail;
    });
    if (frameAttempts && outcomes.length) lines.unshift(tr.attempts);
    if (interrupted) lines.push(tr.interrupted);
    return lines.join('\n') || null;
  }
}

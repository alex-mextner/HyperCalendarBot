import { z } from 'zod';
import { waitForAbort } from '../provider-deadline.ts';
import type { TelegramSender } from '../types.ts';
import {
  type AnswerBinding,
  type AnswerScope,
  answerScopeSchema,
  bindAnswer,
  decideAnswerRelease,
  type QualityAssessment,
} from './answer-quality.ts';

export interface ReplySnapshot {
  readonly binding: Readonly<AnswerBinding>;
  readonly text: string;
}
export interface ReplyRequest {
  scope: AnswerScope;
  text: string;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface ReplyDependencies {
  sender: Pick<TelegramSender, 'sendMessage' | 'editMessageText'>;
  /** Trusted application-owned facts/authorization checker. An LLM must never supply its own approval. */
  assess: (draft: ReplySnapshot, signal: AbortSignal) => Promise<QualityAssessment>;
  /** Advisory, tool-free transformation. Its output is always checked independently. */
  polish?: (draft: ReplySnapshot, signal: AbortSignal) => Promise<string>;
  /** Synchronous, application-owned turn/evidence freshness check, repeated immediately before dispatch. */
  isCurrent: (binding: Readonly<AnswerBinding>) => boolean;
}
export type CorrectionOutcome =
  | 'not_needed'
  | 'not_attempted'
  | 'applied'
  | 'rejected'
  | 'stale'
  | 'timed_out'
  | 'cancelled'
  | 'failed'
  | 'unknown'
  | 'unchanged';
export interface ReplyDeliveryResult {
  delivery: 'not_sent' | 'confirmed' | 'unknown';
  correction: CorrectionOutcome;
  messageId: number | null;
  /** Last text confirmed by transport; an unknown edit outcome may already have changed the remote text. */
  lastConfirmedText: string | null;
  reasons: readonly string[];
  firstDeliveryMs: number | null;
  totalMs: number;
}
const textSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((text) => text.trim().length > 0);
const timeoutSchema = z.number().int().min(1).max(30000);
function snapshot(scope: AnswerScope, text: string): ReplySnapshot {
  const { actorId, chatId, turnId, evidenceRevision } = scope;
  return Object.freeze({
    binding: Object.freeze(bindAnswer({ actorId, chatId, turnId, evidenceRevision }, text)),
    text,
  });
}

/**
 * One owned plain-text delivery, with at most one cosmetic edit of that same message.
 * No business-tool, model-client, retry queue or alternative-recipient capability is exposed here.
 * Unknown UI-send/edit outcomes must be reconciled by the caller, never blindly retried.
 * This object memoizes a run, not durable cross-process exactly-once execution.
 */
export class VerifiedReplyDelivery {
  private readonly original: ReplySnapshot;
  private readonly timeoutMs: number;
  private readonly parent?: AbortSignal;
  private readonly deps: ReplyDependencies;
  private pending: Promise<ReplyDeliveryResult> | undefined;
  constructor(request: ReplyRequest, dependencies: ReplyDependencies) {
    this.original = snapshot(answerScopeSchema.parse(request.scope), request.text);
    this.timeoutMs = timeoutSchema.parse(request.timeoutMs);
    this.parent = request.signal;
    // Capture capabilities and scope now: caller-owned containers cannot redirect a pending request later.
    this.deps = {
      assess: dependencies.assess,
      polish: dependencies.polish,
      isCurrent: dependencies.isCurrent,
      sender: {
        sendMessage: dependencies.sender.sendMessage.bind(dependencies.sender),
        editMessageText: dependencies.sender.editMessageText.bind(dependencies.sender),
      },
    };
  }
  deliver(): Promise<ReplyDeliveryResult> {
    this.pending ??= Promise.resolve().then(() => this.run());
    return this.pending;
  }
  private async run(): Promise<ReplyDeliveryResult> {
    const start = performance.now(),
      controller = new AbortController();
    const signal = this.parent ? AbortSignal.any([this.parent, controller.signal]) : controller.signal;
    const timer = setTimeout(
      () => controller.abort(new DOMException('Reply deadline exceeded', 'TimeoutError')),
      this.timeoutMs,
    );
    let delivery: ReplyDeliveryResult['delivery'] = 'not_sent',
      correction: CorrectionOutcome = 'not_attempted';
    let messageId: number | null = null,
      lastConfirmedText: string | null = null,
      firstDeliveryMs: number | null = null;
    const dispatch = { sendStarted: false, editStarted: false };
    let stage: 'assessment' | 'send' | 'polish' | 'reassessment' | 'edit' = 'assessment';
    let reasons: string[] = [];
    const result = (): ReplyDeliveryResult =>
      Object.freeze({
        delivery,
        correction,
        messageId,
        lastConfirmedText,
        reasons: Object.freeze([...reasons]),
        firstDeliveryMs,
        totalMs: performance.now() - start,
      });
    const current = (draft: ReplySnapshot): boolean => !signal.aborted && this.deps.isCurrent(draft.binding);
    try {
      if (!textSchema.safeParse(this.original.text).success) {
        reasons = ['invalid_initial_text'];
        return result();
      }
      if (!current(this.original)) {
        reasons = ['stale_or_cancelled'];
        return result();
      }
      const assessed = await waitForAbort(() => this.deps.assess(this.original, signal), signal);
      const admission = decideAnswerRelease(this.original.binding, assessed);
      if (admission.kind === 'hold') {
        reasons = admission.reasons;
        return result();
      }
      if (!current(this.original)) {
        reasons = ['stale_or_cancelled'];
        return result();
      }
      stage = 'send';
      const receipt = await waitForAbort(() => {
        if (!current(this.original)) throw new Error('STALE_BEFORE_SEND');
        // Mark unknown only once a transport request is actually dispatched.
        dispatch.sendStarted = true;
        delivery = 'unknown';
        return this.deps.sender.sendMessage(this.original.binding.chatId, this.original.text);
      }, signal);
      if (!Number.isSafeInteger(receipt.message_id) || receipt.message_id <= 0) {
        reasons = ['invalid_delivery_receipt'];
        return result();
      }
      delivery = 'confirmed';
      messageId = receipt.message_id;
      lastConfirmedText = this.original.text;
      firstDeliveryMs = performance.now() - start;
      if (admission.kind === 'send') {
        correction = 'not_needed';
        return result();
      }
      if (!this.deps.polish) {
        reasons = ['no_cosmetic_corrector'];
        return result();
      }
      stage = 'polish';
      if (!current(this.original)) {
        correction = 'stale';
        return result();
      }
      const polisher = this.deps.polish;
      const text = await waitForAbort(() => polisher(this.original, signal), signal);
      if (!current(this.original)) {
        correction = 'stale';
        return result();
      }
      if (!textSchema.safeParse(text).success) {
        correction = 'rejected';
        reasons = ['invalid_correction_text'];
        return result();
      }
      if (text === this.original.text) {
        correction = 'unchanged';
        return result();
      }
      const candidate = snapshot(this.original.binding, text);
      stage = 'reassessment';
      const checked = await waitForAbort(() => this.deps.assess(candidate, signal), signal);
      const revised = decideAnswerRelease(candidate.binding, checked);
      if (revised.kind !== 'send') {
        correction = 'rejected';
        reasons = revised.reasons;
        return result();
      }
      if (!current(candidate)) {
        correction = 'stale';
        return result();
      }
      stage = 'edit';
      const target = messageId;
      await waitForAbort(() => {
        if (!current(candidate)) throw new Error('STALE_BEFORE_EDIT');
        dispatch.editStarted = true;
        correction = 'unknown';
        return this.deps.sender.editMessageText(candidate.binding.chatId, target, candidate.text);
      }, signal);
      correction = 'applied';
      lastConfirmedText = candidate.text;
      return result();
    } catch {
      // Neither provider text nor transport error/request bodies belong in quality telemetry.
      if (stage === 'send') {
        reasons = [dispatch.sendStarted ? 'send_outcome_unknown' : 'send_not_dispatched'];
      } else if (stage === 'edit') {
        reasons = ['edit_outcome_unconfirmed'];
        if (!dispatch.editStarted) correction = 'stale';
      } else if (delivery === 'confirmed') {
        correction = signal.aborted
          ? signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
            ? 'timed_out'
            : 'cancelled'
          : 'failed';
        reasons = ['cosmetic_correction_not_completed'];
      } else {
        reasons = [signal.aborted ? 'assessment_cancelled' : 'assessment_unavailable'];
      }
      return result();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

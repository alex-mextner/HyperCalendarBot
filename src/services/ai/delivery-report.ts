// What the final delivery of an agent reply actually did, read from the Telegram API results: which
// messages were sent or edited and whether any call failed. Message ids and counts only, never text.
// A reply the bot believes it delivered is only as good as this evidence (production, 2026-11-01:
// the logs said "delivered" and could not say which message the user got).

/**
 * delivered: a new message was sent. edited: the placeholder was edited into the reply.
 * fallback: the plain error text went out instead. failed: a Telegram call failed and no fallback
 * covered it. unknown: Telegram answered without a usable message id, or nothing was attempted.
 * discarded: the draft was removed and nothing is shown.
 */
export type DeliveryOutcome = 'delivered' | 'edited' | 'fallback' | 'failed' | 'unknown' | 'discarded';

export interface DeliveryReport {
  outcome: DeliveryOutcome;
  /** Telegram message ids the delivery created or edited, in order; empty when none is known. */
  messageIds: readonly number[];
}

function isMessageId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export class DeliveryLedger {
  private firstKind: 'sent' | 'edited' | null = null;
  private readonly ids: number[] = [];
  private failures = 0;
  private fallbackLanded = false;
  private unusableAnswers = 0;

  /** A final-text call succeeded: `sent` created a message, `edited` changed an existing one. */
  record(kind: 'sent' | 'edited', messageId: unknown): void {
    this.firstKind ??= kind;
    this.note(messageId);
  }

  /** The plain error text reached the chat after the normal delivery could not. */
  recordFallback(messageId: unknown): void {
    this.fallbackLanded = true;
    this.note(messageId);
  }

  failed(): void {
    this.failures++;
  }

  private note(messageId: unknown): void {
    if (!isMessageId(messageId)) this.unusableAnswers++;
    else if (!this.ids.includes(messageId)) this.ids.push(messageId);
  }

  report(): DeliveryReport {
    const messageIds = [...this.ids];
    if (this.fallbackLanded) return { outcome: 'fallback', messageIds };
    if (this.failures > 0) return { outcome: 'failed', messageIds };
    if (this.firstKind === null || this.unusableAnswers > 0) return { outcome: 'unknown', messageIds };
    return { outcome: this.firstKind === 'edited' ? 'edited' : 'delivered', messageIds };
  }
}

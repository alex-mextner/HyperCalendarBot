/** Delivery facts produced by the picker transport, never parsed from user or profile text. */
export interface InvitationDeliveryReceipt {
  eventId: number;
  recipientId: number;
  outcome: 'delivered' | 'manual_forward' | 'failed' | 'unconfirmed' | 'not_configured';
}

const OUTCOMES = new Set<InvitationDeliveryReceipt['outcome']>([
  'delivered',
  'manual_forward',
  'failed',
  'unconfirmed',
  'not_configured',
]);

/** Only the picker's ten numeric identities and finite outcomes can enter this evidence block. */
export function invitationReceiptsBlock(receipts: readonly InvitationDeliveryReceipt[] | undefined): string {
  return JSON.stringify(
    (receipts ?? [])
      .slice(0, 10)
      .filter(
        (receipt) =>
          Number.isSafeInteger(receipt.eventId) &&
          receipt.eventId > 0 &&
          Number.isSafeInteger(receipt.recipientId) &&
          receipt.recipientId > 0 &&
          OUTCOMES.has(receipt.outcome),
      )
      .map(({ eventId, recipientId, outcome }) => ({ eventId, recipientId, outcome })),
  );
}

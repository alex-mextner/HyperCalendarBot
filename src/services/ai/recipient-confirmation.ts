/** Actor/event/recipient-bound approval; restarts and expiry fail closed. */
interface Approval {
  actorId: number;
  eventId: number;
  recipientId: number;
  expiresAt: number;
  confirmed: boolean;
}
const approvals = new Map<string, Approval>();
const TTL = 5 * 60_000;
export function issueRecipientApproval(
  actorId: number,
  eventId: number,
  recipientId: number,
  now = Date.now(),
): string {
  for (const [token, item] of approvals) if (item.expiresAt <= now) approvals.delete(token);
  if (approvals.size >= 1000) {
    const first = approvals.keys().next().value;
    if (first) approvals.delete(first);
  }
  const token = crypto.randomUUID();
  approvals.set(token, { actorId, eventId, recipientId, expiresAt: now + TTL, confirmed: false });
  return token;
}
export function confirmRecipientApproval(
  token: string,
  actorId: number,
  chatId: number,
  now = Date.now(),
): Approval | null {
  const item = approvals.get(token);
  if (!item || item.confirmed || item.actorId !== actorId || chatId !== actorId || item.expiresAt <= now) return null;
  item.confirmed = true;
  return { ...item };
}
export function consumeRecipientApproval(
  actorId: number,
  eventId: number,
  recipientId: number,
  now = Date.now(),
): boolean {
  for (const [token, item] of approvals) {
    if (item.expiresAt <= now) {
      approvals.delete(token);
      continue;
    }
    if (item.confirmed && item.actorId === actorId && item.eventId === eventId && item.recipientId === recipientId) {
      approvals.delete(token);
      return true;
    }
  }
  return false;
}

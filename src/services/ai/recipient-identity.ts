import type { Contact } from '../../database/types.ts';
import { consumeRecipientApproval } from './recipient-confirmation.ts';
import type { AgentContext } from './types.ts';

export function normalizeRecipientUsername(username: string): string {
  return username.trim().replace(/^@/, '').toLowerCase();
}

export function hasExplicitUsername(message: string, username: string): boolean {
  const expected = normalizeRecipientUsername(username);
  const handles = message.match(/(?<![a-zA-Z0-9_@])@[a-zA-Z0-9_]+/g) ?? [];
  if (handles.some((handle) => normalizeRecipientUsername(handle) === expected)) return true;
  const links = message.matchAll(/(?<![a-zA-Z0-9_./-])(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([a-zA-Z0-9_]+)/g);
  return [...links].some((match) => match[1]?.toLowerCase() === expected);
}

export function canResolveRecipientUsername(ctx: AgentContext, username: string): boolean {
  return (
    hasExplicitUsername(ctx.messageText, username) || !!ctx.contactRepo?.findByUsername(ctx.user.telegram_id, username)
  );
}

export function isKnownRecipient(ctx: AgentContext, id: number): boolean {
  if (id === ctx.user.telegram_id || ctx.verifiedRecipientIds?.has(id)) return true;
  const contact = ctx.contactRepo?.findByTelegramId(ctx.user.telegram_id, id);
  if (contact && (contact.username || (contact.name.trim() && contact.name !== `User ${id}`))) return true;
  return (ctx.messageText.match(/\b\d+\b/g) ?? []).some((value) => value === String(id));
}

export interface KnownBotUser {
  id: number;
  firstName?: string;
  username: string;
}

/** Resolves a normalized @username against people who have started this bot (the users table only);
 *  anyone else has to be shared through the picker. */
export function lookupKnownBotUser(ctx: AgentContext, username: string): KnownBotUser | null {
  const user = ctx.userRepo.findByUsername(username);
  if (!user) return null;
  return { id: user.telegram_id, firstName: user.first_name ?? undefined, username: user.username ?? username };
}

/** Records that this run established `id` as a real recipient, so later tool calls may address it. */
export function markVerifiedRecipient(ctx: AgentContext, id: number): void {
  ctx.verifiedRecipientIds ??= new Set();
  ctx.verifiedRecipientIds.add(id);
}

type RecipientResolution =
  | { ok: true; id: number; username?: string; firstName?: string; isGroup: boolean }
  | { ok: false; reason: 'contact_row_id'; contact: Contact }
  | {
      ok: false;
      reason: 'unverified' | 'conflict' | 'not_found';
      username?: string;
      candidate?: { id: number; firstName?: string; username?: string };
    };

export async function resolveInvitationRecipient(
  ctx: AgentContext,
  input: { invitee_id?: number; invitee_username?: string; force?: boolean; event_id?: number },
  establishedInvitationRecipientId?: number,
): Promise<RecipientResolution> {
  const savedByHint =
    input.invitee_username && !hasExplicitUsername(ctx.messageText, input.invitee_username)
      ? ctx.contactRepo?.findByUsername(ctx.user.telegram_id, input.invitee_username)
      : null;
  const id =
    input.invitee_id ??
    (savedByHint && !/^User \d+$/.test(savedByHint.name) ? (savedByHint.telegram_id ?? undefined) : undefined);
  if (id !== undefined && (!Number.isSafeInteger(id) || id === 0)) return { ok: false, reason: 'unverified' };
  if (id !== undefined && id < 0) {
    if (input.invitee_username) return { ok: false, reason: 'conflict' };
    let known =
      establishedInvitationRecipientId === id ||
      ctx.verifiedRecipientIds?.has(id) === true ||
      (ctx.isGroup && ctx.groupChatId === id);
    // Intent evidence and current membership are separate requirements.
    if (!known) return { ok: false, reason: 'unverified' };
    if (!(ctx.isGroup && ctx.groupChatId === id)) {
      if (!ctx.group) return { ok: false, reason: 'unverified' };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        known = await Promise.race([
          ctx.group.checkGroupMembership(id, ctx.user.telegram_id),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 3000);
          }),
        ]);
      } catch {
        return { ok: false, reason: 'unverified' };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return known ? { ok: true, id, isGroup: true } : { ok: false, reason: 'unverified' };
  }
  // An explicit invitee_id that is an owned address-book row ID is ambiguous recipient evidence even when a saved
  // contact has that Telegram ID: only an ID verified in this conversation (picker, username) or the invitation's
  // own recipient overrides it. An ID derived from a saved @username is that contact's Telegram ID, not a row ID.
  const addressBookRow =
    input.invitee_id !== undefined &&
    input.invitee_id !== establishedInvitationRecipientId &&
    !ctx.verifiedRecipientIds?.has(input.invitee_id)
      ? ctx.contactRepo?.findById(ctx.user.telegram_id, input.invitee_id)
      : null;
  if (addressBookRow && addressBookRow.telegram_id !== id)
    return { ok: false, reason: 'contact_row_id', contact: addressBookRow };
  if (input.force && id !== undefined && id > 0 && input.event_id !== undefined) {
    if (!consumeRecipientApproval(ctx.user.telegram_id, input.event_id, id)) return { ok: false, reason: 'unverified' };
    return { ok: true, id, isGroup: false };
  }
  const owned = id === undefined ? null : ctx.contactRepo?.findByTelegramId(ctx.user.telegram_id, id);
  const hint = input.invitee_username ? normalizeRecipientUsername(input.invitee_username) : '';
  const pinnedMetadata = !!(
    owned &&
    !/^User \d+$/.test(owned.name) &&
    hint &&
    normalizeRecipientUsername(owned.username ?? '') === hint &&
    !hasExplicitUsername(ctx.messageText, hint)
  );
  if (input.invitee_username && !pinnedMetadata) {
    const username = normalizeRecipientUsername(input.invitee_username);
    if (!canResolveRecipientUsername(ctx, username)) {
      return { ok: false, reason: 'unverified' };
    }
    const resolved = lookupKnownBotUser(ctx, username);
    if (!resolved) return { ok: false, reason: 'not_found', username };
    if (!Number.isSafeInteger(resolved.id) || resolved.id <= 0) return { ok: false, reason: 'unverified' };
    if (id !== undefined && id !== resolved.id) return { ok: false, reason: 'conflict', candidate: resolved };
    markVerifiedRecipient(ctx, resolved.id);
    return { ok: true, ...resolved, isGroup: false };
  }
  if (id === undefined || (id !== establishedInvitationRecipientId && !isKnownRecipient(ctx, id)))
    return { ok: false, reason: 'unverified' };
  // Do not reuse stale username metadata as an alternative delivery destination.
  return { ok: true, id, isGroup: false };
}

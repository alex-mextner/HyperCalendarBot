import { consumeRecipientApproval } from './recipient-confirmation.ts';
import { inspectRecipientProfile } from './recipient-profile.ts';
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

type RecipientResolution =
  | { ok: true; id: number; username?: string; firstName?: string; isGroup: boolean }
  | {
      ok: false;
      reason: 'unverified' | 'conflict' | 'not_found' | 'unavailable';
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
    return input.invitee_username ? { ok: false, reason: 'conflict' } : { ok: true, id, isGroup: true };
  }
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
    const known = ctx.userRepo.findByUsername(username);
    if (!canResolveRecipientUsername(ctx, username)) {
      return { ok: false, reason: 'unverified' };
    }
    if (!known && !ctx.resolveUsername) return { ok: false, reason: 'unavailable' };
    const resolved = ctx.resolveUsername
      ? await ctx.resolveUsername(username)
      : known
        ? { id: known.telegram_id, firstName: known.first_name ?? undefined, username: known.username ?? username }
        : null;
    if (!resolved) return { ok: false, reason: 'not_found', username };
    if (!Number.isSafeInteger(resolved.id) || resolved.id <= 0) return { ok: false, reason: 'unverified' };
    if (id !== undefined && id !== resolved.id) return { ok: false, reason: 'conflict', candidate: resolved };
    ctx.verifiedRecipientIds ??= new Set();
    ctx.verifiedRecipientIds.add(resolved.id);
    return {
      ok: true,
      id: resolved.id,
      username: resolved.username ?? username,
      firstName: resolved.firstName,
      isGroup: false,
    };
  }
  if (id === undefined || (id !== establishedInvitationRecipientId && !isKnownRecipient(ctx, id)))
    return { ok: false, reason: 'unverified' };
  if (ctx.lookupTelegramUser) {
    const profile = await Promise.race([
      inspectRecipientProfile(ctx, id),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
    ]);
    if (profile) {
      if (profile.id !== id || profile.deleted) return { ok: false, reason: 'conflict' };
      ctx.contactRepo?.refreshProfile(ctx.user.telegram_id, id, {
        username: profile.username ?? null,
        firstName: profile.firstName,
      });
      return {
        ok: true,
        id,
        username: profile.username,
        firstName: profile.firstName,
        isGroup: false,
      };
    }
  }
  // An unavailable profile lookup cannot invalidate a previously established ID.
  // Do not reuse stale username metadata as an alternative delivery destination.
  return { ok: true, id, isGroup: false };
}

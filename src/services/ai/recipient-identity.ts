import type { Contact } from '../../database/types.ts';
import type { TelegramProfile } from '../telegram-session/service-tier.ts';
import { consumeRecipientApproval } from './recipient-confirmation.ts';
import { cachedRecipientProfile } from './recipient-profile.ts';
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

export interface FoundUser {
  id: number;
  firstName?: string;
  username: string;
}

/** Resolves a normalized @username against people who have started this bot (the users table only).
 *  A row whose telegram_id is not a positive safe integer names no real person, so it counts as not found. */
function lookupKnownBotUser(ctx: AgentContext, username: string): FoundUser | null {
  const user = ctx.userRepo.findByUsername(username);
  if (!user || !Number.isSafeInteger(user.telegram_id) || user.telegram_id <= 0) return null;
  return { id: user.telegram_id, firstName: user.first_name ?? undefined, username: user.username ?? username };
}

export type UsernameLookup =
  | { status: 'found'; user: FoundUser }
  /** Telegram answered that no account has this username. */
  | { status: 'not_found' }
  /** The username could not be looked up: without the service account only people who started this
   *  bot can be, and a service lookup can fail. Says nothing about whether the person exists. */
  | { status: 'unavailable' }
  /** The service account answered with an ID that names no real person. */
  | { status: 'unverified' };

/** Looks up an exact normalized @username. With the service account (ctx.resolveUsername) Telegram's
 *  answer wins over the users table, which may hold a stale username; without it only the users table
 *  is consulted. */
export async function lookUpUsername(ctx: AgentContext, username: string): Promise<UsernameLookup> {
  if (!ctx.resolveUsername) {
    const known = lookupKnownBotUser(ctx, username);
    return known ? { status: 'found', user: known } : { status: 'unavailable' };
  }
  let profile: TelegramProfile | null;
  try {
    profile = await ctx.resolveUsername(username);
  } catch {
    return { status: 'unavailable' };
  }
  if (!profile) return { status: 'not_found' };
  if (!Number.isSafeInteger(profile.id) || profile.id <= 0) return { status: 'unverified' };
  return {
    status: 'found',
    user: { id: profile.id, firstName: profile.firstName, username: profile.username ?? username },
  };
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
      reason: 'unverified' | 'conflict' | 'not_found' | 'unavailable';
      username?: string;
      candidate?: { id: number; firstName?: string; username?: string };
    };

type RecipientInput = { invitee_id?: number; invitee_username?: string; force?: boolean; event_id?: number };
type Unverified = { ok: false; reason: 'unverified' };

const UNVERIFIED: Unverified = { ok: false, reason: 'unverified' };

/** The Telegram ID the caller means: an explicit invitee_id, else the ID of a saved contact named by @username. */
function candidateRecipientId(ctx: AgentContext, input: RecipientInput): number | undefined {
  const savedByHint =
    input.invitee_username && !hasExplicitUsername(ctx.messageText, input.invitee_username)
      ? ctx.contactRepo?.findByUsername(ctx.user.telegram_id, input.invitee_username)
      : null;
  return (
    input.invitee_id ??
    (savedByHint && !/^User \d+$/.test(savedByHint.name) ? (savedByHint.telegram_id ?? undefined) : undefined)
  );
}

/** Current membership of the user in the group, bounded by a 3s timeout; any failure counts as not a member. */
async function isCurrentGroupMember(ctx: AgentContext, groupId: number): Promise<boolean> {
  if (!ctx.group) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ctx.group.checkGroupMembership(groupId, ctx.user.telegram_id),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 3000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Negative IDs name group chats: they need intent evidence and, unless it is the current chat, current membership. */
async function resolveGroupRecipient(
  ctx: AgentContext,
  input: RecipientInput,
  id: number,
  establishedInvitationRecipientId?: number,
): Promise<RecipientResolution> {
  if (input.invitee_username) return { ok: false, reason: 'conflict' };
  const inCurrentGroup = ctx.isGroup && ctx.groupChatId === id;
  const hasIntent =
    establishedInvitationRecipientId === id || ctx.verifiedRecipientIds?.has(id) === true || inCurrentGroup;
  // Intent evidence and current membership are separate requirements.
  if (!hasIntent) return UNVERIFIED;
  if (!inCurrentGroup && !(await isCurrentGroupMember(ctx, id))) return UNVERIFIED;
  return { ok: true, id, isGroup: true };
}

/** An explicit invitee_id that is an owned address-book row ID is ambiguous recipient evidence even when a saved
 *  contact has that Telegram ID: only an ID verified in this conversation (picker, username) or the invitation's
 *  own recipient overrides it. An ID derived from a saved @username is that contact's Telegram ID, not a row ID. */
function findAmbiguousContactRow(
  ctx: AgentContext,
  input: RecipientInput,
  id: number | undefined,
  establishedInvitationRecipientId?: number,
): Contact | null {
  if (
    input.invitee_id === undefined ||
    input.invitee_id === establishedInvitationRecipientId ||
    ctx.verifiedRecipientIds?.has(input.invitee_id)
  )
    return null;
  const row = ctx.contactRepo?.findById(ctx.user.telegram_id, input.invitee_id);
  return row && row.telegram_id !== id ? row : null;
}

/** True when a saved contact already pins this ID's @username metadata and the message does not restate it. */
function isPinnedContactMetadata(ctx: AgentContext, input: RecipientInput, id: number | undefined): boolean {
  const owned = id === undefined ? null : ctx.contactRepo?.findByTelegramId(ctx.user.telegram_id, id);
  const hint = input.invitee_username ? normalizeRecipientUsername(input.invitee_username) : '';
  return !!(
    owned &&
    !/^User \d+$/.test(owned.name) &&
    hint &&
    normalizeRecipientUsername(owned.username ?? '') === hint &&
    !hasExplicitUsername(ctx.messageText, hint)
  );
}

async function resolveRecipientByUsername(
  ctx: AgentContext,
  invitee_username: string,
  id: number | undefined,
): Promise<RecipientResolution> {
  const username = normalizeRecipientUsername(invitee_username);
  if (!canResolveRecipientUsername(ctx, username)) return UNVERIFIED;
  const lookup = await lookUpUsername(ctx, username);
  if (lookup.status === 'not_found' || lookup.status === 'unavailable')
    return { ok: false, reason: lookup.status, username };
  if (lookup.status === 'unverified') return UNVERIFIED;
  const resolved = lookup.user;
  if (id !== undefined && id !== resolved.id) return { ok: false, reason: 'conflict', candidate: resolved };
  markVerifiedRecipient(ctx, resolved.id);
  return { ok: true, ...resolved, isGroup: false };
}

function resolveRecipientByKnownId(
  ctx: AgentContext,
  id: number | undefined,
  establishedInvitationRecipientId?: number,
): RecipientResolution {
  if (id === undefined || (id !== establishedInvitationRecipientId && !isKnownRecipient(ctx, id))) return UNVERIFIED;
  const profile = ctx.lookupTelegramUser ? cachedRecipientProfile(ctx, id) : null;
  if (profile) {
    if (profile.id !== id || profile.deleted) return { ok: false, reason: 'conflict' };
    ctx.contactRepo?.refreshProfile(ctx.user.telegram_id, id, {
      username: profile.username ?? null,
      firstName: profile.firstName,
    });
    return { ok: true, id, username: profile.username, firstName: profile.firstName, isGroup: false };
  }
  // An unavailable profile lookup cannot invalidate a previously established ID.
  // Do not reuse stale username metadata as an alternative delivery destination.
  return { ok: true, id, isGroup: false };
}

export async function resolveInvitationRecipient(
  ctx: AgentContext,
  input: RecipientInput,
  establishedInvitationRecipientId?: number,
): Promise<RecipientResolution> {
  const id = candidateRecipientId(ctx, input);
  if (id !== undefined && (!Number.isSafeInteger(id) || id === 0)) return UNVERIFIED;
  if (id !== undefined && id < 0) return resolveGroupRecipient(ctx, input, id, establishedInvitationRecipientId);
  const contactRow = findAmbiguousContactRow(ctx, input, id, establishedInvitationRecipientId);
  if (contactRow) return { ok: false, reason: 'contact_row_id', contact: contactRow };
  if (input.force && id !== undefined && id > 0 && input.event_id !== undefined) {
    if (!consumeRecipientApproval(ctx.user.telegram_id, input.event_id, id)) return UNVERIFIED;
    return { ok: true, id, isGroup: false };
  }
  if (input.invitee_username && !isPinnedContactMetadata(ctx, input, id))
    return resolveRecipientByUsername(ctx, input.invitee_username, id);
  return resolveRecipientByKnownId(ctx, id, establishedInvitationRecipientId);
}

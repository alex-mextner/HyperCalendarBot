// Group event create/update fan-out: builds one localized HTML notification per registered member
// and hands the batch to the broadcast queue. The count it returns is what the tool result may claim.
import { t } from '../../../../config/constants.ts';
import type { CalendarEvent } from '../../../../database/types.ts';
import { escapeHtml } from '../../../../utils/telegram.ts';
import { formatEventDetail } from '../../../event/formatters.ts';
import type { AgentContext } from '../../types.ts';
import { eventsLogger } from './types.ts';

function buildOrganizerLink(user: AgentContext['user']): string {
  if (user.username) return `@${escapeHtml(user.username)}`;
  const name = user.first_name ?? String(user.telegram_id);
  return `<a href="tg://user?id=${user.telegram_id}">${escapeHtml(name)}</a>`;
}

function buildGroupEventNotification(
  event: CalendarEvent,
  lang: 'en' | 'ru',
  timezone: string,
  groupLabel: string,
  inviteLink: string | null,
  organizerLink: string,
  action: 'created' | 'updated',
): string {
  const safeLink = inviteLink?.replace(/[<>"]/g, encodeURIComponent);
  const groupRef = safeLink
    ? `<a href="${safeLink}">${escapeHtml(groupLabel)}</a>`
    : `<b>${escapeHtml(groupLabel)}</b>`;
  const translations = t(lang);
  const header =
    action === 'created'
      ? translations.group_event_created(groupRef, organizerLink)
      : translations.group_event_updated(groupRef, organizerLink);
  const body = formatEventDetail(event, timezone, lang);
  return `${header}\n\n${body}`;
}

function buildRecipientMention(
  recipientUser: { first_name?: string | null; username?: string | null; telegram_id: number } | null,
  userId: number,
): string {
  if (recipientUser?.username) return `@${escapeHtml(recipientUser.username)}`;
  const name = recipientUser?.first_name ?? String(userId);
  return `<a href="tg://user?id=${userId}">${escapeHtml(name)}</a>`;
}

/**
 * Enqueue per-recipient broadcast jobs for a group event create/update.
 *
 * Returns the number of enqueued recipients (0 if unavailable). The caller
 * should await this so the tool result honestly reflects "notifications
 * queued for N members" instead of a fire-and-forget lie.
 *
 * Each recipient gets a language- and timezone-localized message formatted
 * at enqueue time; the worker just dispatches the pre-formatted text.
 */
export async function enqueueGroupNotifications(
  ctx: AgentContext,
  event: CalendarEvent,
  action: 'created' | 'updated',
): Promise<number> {
  if (!ctx.groupChatId || !ctx.group?.groupMemberService || !ctx.broadcast) return 0;
  const groupChat = ctx.group.groupChatRepo.findByChatId(ctx.groupChatId);
  const groupLabel = ctx.groupTitle ?? groupChat?.title ?? String(ctx.groupChatId);
  const inviteLink = groupChat?.invite_link ?? null;
  const organizerLink = buildOrganizerLink(ctx.user);

  let memberIds: number[];
  try {
    memberIds = await ctx.group.groupMemberService.getRegisteredMembers(ctx.groupChatId);
  } catch (err) {
    eventsLogger.error({ err, groupChatId: ctx.groupChatId }, 'Group member fetch failed');
    return 0;
  }

  if (memberIds.length === 0) return 0;

  const batchId = `${action}:${event.id}:${Date.now()}`;
  const lang = (ctx.user.language ?? 'en') as 'en' | 'ru';

  // Register batch for aggregated failure tracking (share link + group context)
  if (ctx.broadcast.registerBatch && ctx.deepLinkService && ctx.botUsername) {
    try {
      const link = ctx.deepLinkService.createShareLink(event.id, ctx.user.telegram_id);
      const shareUrl = ctx.deepLinkService.generateUrl(link.code, ctx.botUsername);
      await ctx.broadcast.registerBatch(batchId, {
        total: memberIds.length,
        groupChatId: ctx.groupChatId,
        threadId: ctx.topicThreadId,
        fallbackText: t(lang).invite_deep_link(escapeHtml(event.title), shareUrl),
      });
    } catch (err) {
      eventsLogger.warn({ err, eventId: event.id }, 'Failed to register broadcast batch');
    }
  }

  const jobs = memberIds.map((userId) => {
    const recipientUser = ctx.userRepo.findByTelegramId(userId);
    const recipientLang = (recipientUser?.language ?? 'en') as 'en' | 'ru';
    const recipientTimezone = recipientUser?.timezone ?? ctx.user.timezone;
    const text = buildGroupEventNotification(
      event,
      recipientLang,
      recipientTimezone,
      groupLabel,
      inviteLink,
      organizerLink,
      action,
    );

    return {
      recipientId: userId,
      text,
      parseMode: 'HTML' as const,
      origin: `group_event_${action}:${event.id}`,
      batchId,
      recipientMention: buildRecipientMention(recipientUser, userId),
    };
  });

  try {
    await ctx.broadcast.enqueueBatch(jobs);
    return jobs.length;
  } catch (err) {
    eventsLogger.error({ err, eventId: event.id, count: jobs.length }, 'Failed to enqueue group notifications');
    return 0;
  }
}

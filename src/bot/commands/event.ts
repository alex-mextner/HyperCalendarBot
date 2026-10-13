// src/bot/commands/event.ts
//
// Command entrypoint for GH-653's canonical event display: `/event <id|query>` with no AI or
// intent layer involved — it calls the same `event-display.ts` helpers `show_event`
// (src/services/ai/tool-handlers/events.ts) and the `CB.EVENT_VIEW` callback
// (src/bot/handlers/callback.handler.ts) use, so all three surfaces render byte-identical cards.
import { CB, t } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { EventOccurrence } from '../../database/types.ts';
import { formatEmptyAgenda } from '../../services/ai/empty-agenda.ts';
import { enrichAgenda, enrichAgendaEvents } from '../../services/event/agenda-enrichment.ts';
import { buildCanonicalEventCard, buildEventPicker, decideEventDisplay } from '../../services/event/event-display.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { getDayRangeUtc } from '../../utils/date.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';
import { sendAgendaText } from './agenda-text.ts';

const NUMERIC_ID_RE = /^\d+$/;

/** Send the single-card / picker / empty decision for a set of occurrences. `emptyText` is the
 *  caller's own "nothing found" wording — a day with no events reads differently from a search
 *  with no matches, so it is never hardcoded here. */
async function sendOccurrenceResult(
  ctx: BotCommandContext,
  occurrences: EventOccurrence[],
  timezone: string,
  lang: 'en' | 'ru',
  emptyText: string,
): Promise<void> {
  const decision = decideEventDisplay(occurrences);
  if (decision.kind === 'empty') {
    await ctx.send(emptyText);
    return;
  }
  if (decision.kind === 'multiple') {
    const keyboard = buildEventPicker(decision.occurrences, timezone, CB.EVENT_VIEW, lang);
    await ctx.send(t(lang).aiTools.meta.showEventPickPrompt, { reply_markup: keyboard });
    return;
  }
  const card = buildCanonicalEventCard(decision.event, timezone, lang, decision.occurrenceDate);
  await sendAgendaText(ctx, card.text, { reply_markup: card.keyboard });
}

export async function handleEvent(
  ctx: BotCommandContext,
  eventService: EventService,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as 'en' | 'ru';
  const arg = (ctx.args ?? '').trim();

  const group = isGroup(ctx);
  const groupId = group ? getGroupId(ctx) : null;
  if (group && groupId === null) return;
  const timezone = groupId !== null ? (groupRepo?.getTimezone(groupId) ?? user.timezone) : user.timezone;
  const viewer = { userId: user.telegram_id, language: lang, groupId: groupId ?? undefined };

  if (NUMERIC_ID_RE.test(arg)) {
    const eventId = Number(arg);
    const event =
      groupId !== null
        ? eventService.getEventForGroup(eventId, groupId)
        : eventService.getEvent(eventId, user.telegram_id);
    if (!event) {
      await ctx.send(t(lang).callbackErrors.notFound);
      return;
    }
    const displayEvent = enrichAgendaEvents([event], viewer, eventService.agendaRepository)[0]!;
    const card = buildCanonicalEventCard(displayEvent, timezone, lang);
    await sendAgendaText(ctx, card.text, { reply_markup: card.keyboard });
    return;
  }

  if (arg) {
    const results =
      groupId !== null
        ? eventService.searchEventsForGroup(groupId, arg)
        : eventService.searchEvents(user.telegram_id, arg);
    const occurrences: EventOccurrence[] = results.map((event) => ({
      event,
      occurrence_start: event.start_at,
      occurrence_end: event.end_at,
      is_exception: false,
    }));
    const enriched = enrichAgenda(occurrences, viewer, eventService.agendaRepository);
    await sendOccurrenceResult(ctx, enriched, timezone, lang, t(lang).search_no_results);
    return;
  }

  // No args: the one event on today's date, the same natural default as "покажи сегодняшнюю встречу".
  const { start, end } = getDayRangeUtc(new Date(), timezone);
  const occurrences =
    groupId !== null
      ? eventService.getEventsInRangeForGroup(groupId, start, end)
      : eventService.getEventsInRange(user.telegram_id, start, end);
  const enriched = enrichAgenda(occurrences, viewer, eventService.agendaRepository);
  // Same wording as an empty show_event/get_events read: names the day and the calendar checked.
  const emptyText = formatEmptyAgenda({
    interval: { start: new Date(start), end: new Date(end) },
    timezone,
    language: lang,
    scope: groupId !== null ? 'group' : 'personal',
  });
  await sendOccurrenceResult(ctx, enriched, timezone, lang, emptyText);
}

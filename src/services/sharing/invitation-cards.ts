// Delivered invitation cards, re-rendered in place when the event's place is confirmed or dropped
// and whenever its roster changes (someone is invited, answers, or is withdrawn).
import type { InlineKeyboard } from 'gramio';
import type { AgendaRepository } from '../../database/repositories/agenda.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { CalendarEvent, Invitation, InvitationStatus } from '../../database/types.ts';
import { botLogger } from '../../utils/logger.ts';
import { formatInvitation } from '../event/formatters.ts';
import type { DomainEventMap } from '../scheduled/domain-event-bus.ts';
import type { WeatherService } from '../weather/weather-service.ts';
import { formatAnsweredInvitationCard } from './answered-invitation-card.ts';
import { readInvitationRoster } from './invitation-roster.ts';
import { groupRsvpKeyboard, invitationRsvpKeyboard } from './invitation-rsvp-keyboard.ts';

const logger = botLogger.child({ module: 'invitation-cards' });

export type InvitationEditOptions = { parse_mode: 'HTML'; reply_markup?: InlineKeyboard };
type RenderedInvitationCard = { text: string; options: InvitationEditOptions };
/** Statuses whose card is still on screen as the recipient last saw it */
type LiveInvitationStatus = Exclude<InvitationStatus, 'cancelled' | 'expired'>;

export interface InvitationCardDeps {
  invitationRepo: Pick<InvitationRepository, 'getByEvent' | 'findById' | 'getRoster'>;
  userRepo: Pick<UserRepository, 'findByTelegramId'>;
  /** Invitee's view of the event on an answered card when no roster may be shown */
  agendaRepository?: AgendaRepository;
  /** Forecast line on an accepted card; absent when weather is not configured */
  weatherService?: Pick<WeatherService, 'getForecastAt'>;
  /** Edits a delivered card; the edit replaces its inline keyboard with `reply_markup` */
  editMessage: (chatId: number, messageId: number, text: string, options: InvitationEditOptions) => Promise<void>;
}

async function renderInvitationCard(
  event: CalendarEvent,
  inv: Invitation,
  status: LiveInvitationStatus,
  chatId: number,
  deps: InvitationCardDeps,
): Promise<RenderedInvitationCard> {
  const inviter = deps.userRepo.findByTelegramId(inv.inviter_id);
  const inviterName = inviter?.first_name ?? inviter?.username ?? 'User';
  const roster = readInvitationRoster(deps.invitationRepo, event.id, chatId);

  if (inv.invitee_id < 0) {
    const groupLang = inviter?.language ?? 'en';
    const text = formatInvitation(
      event,
      event.timezone,
      groupLang,
      inviterName,
      inv.inviter_id,
      inviter?.username,
      null,
      false,
      roster,
    );
    return {
      text,
      options: { parse_mode: 'HTML', reply_markup: groupRsvpKeyboard(event.id, groupLang, event) },
    };
  }

  const invitee = deps.userRepo.findByTelegramId(inv.invitee_id);
  const inviteeLang = invitee?.language ?? 'en';

  if (status === 'pending') {
    const text = formatInvitation(
      event,
      event.timezone,
      inviteeLang,
      inviterName,
      inv.inviter_id,
      inviter?.username,
      invitee?.timezone,
      invitee?.onboarding_completed === 1,
      roster,
    );
    return {
      text,
      options: { parse_mode: 'HTML', reply_markup: invitationRsvpKeyboard(inv.id, inviteeLang, event) },
    };
  }

  const text = await formatAnsweredInvitationCard(
    status,
    event,
    { userId: inv.invitee_id, language: inviteeLang, timezone: invitee?.timezone ?? event.timezone },
    { agendaRepository: deps.agendaRepository, weatherService: deps.weatherService },
    roster,
  );
  return { text, options: { parse_mode: 'HTML' } };
}

/**
 * Re-render every delivered invitation card of the event in the form its recipient last saw, with
 * the current event details and roster. A Telegram text edit without reply_markup deletes the inline
 * keyboard, so actionable cards send theirs again: a group card keeps Going/Not going for every
 * member, a pending personal card keeps its RSVP keyboard, both with the Map button while `event` has
 * a confirmed place, and an answered card keeps its answer line without buttons. Cancelled and
 * expired cards are left as they are, and so is a pending card whose invitee proposed another time
 * (the proposal-sent notice replaced it until the inviter settles it).
 * `skipInvitationId` names a card its own callback is rewriting right now.
 */
export async function refreshInvitationCards(
  event: CalendarEvent,
  deps: InvitationCardDeps,
  skipInvitationId?: number,
): Promise<void> {
  for (const inv of deps.invitationRepo.getByEvent(event.id)) {
    if (inv.id === skipInvitationId || !inv.message_id || !inv.chat_id) continue;
    if (inv.status === 'cancelled' || inv.status === 'expired') continue;
    if (inv.status === 'pending' && inv.proposed_time) continue;

    try {
      const card = await renderInvitationCard(event, inv, inv.status, inv.chat_id, deps);
      // Earlier edits in this loop yield, and an invitee can answer or propose a time meanwhile: that
      // callback has then already rewritten the card, so a stale render must not overwrite it.
      const current = deps.invitationRepo.findById(inv.id);
      if (current?.status !== inv.status || current.proposed_time !== inv.proposed_time) continue;
      await deps.editMessage(inv.chat_id, inv.message_id, card.text, card.options);
    } catch (err) {
      // Telegram refuses an edit that changes nothing, e.g. when only a hidden invitee's answer moved.
      if (err instanceof Error && err.message.includes('message is not modified')) continue;
      logger.warn({ err, invitationId: inv.id, eventId: event.id }, 'Failed to update a delivered invitation card');
    }
  }
}

/**
 * Keeps delivered cards in step with their roster. One event is refreshed one pass at a time: a change
 * that arrives mid-pass schedules exactly one more, so a burst of answers (a group tapping Going)
 * costs at most two passes, and the last edit of every card renders the latest roster.
 */
export class InvitationCardRefresher {
  private readonly inFlight = new Map<number, { rerun: boolean }>();

  constructor(private readonly deps: InvitationCardDeps & { eventRepo: Pick<EventRepository, 'findById'> }) {}

  async refresh(change: DomainEventMap['invitationRoster.changed']): Promise<void> {
    const running = this.inFlight.get(change.eventId);
    if (running) {
      running.rerun = true;
      return;
    }
    const state = { rerun: false };
    this.inFlight.set(change.eventId, state);
    try {
      // Only the first pass may skip the answered card: a later change can concern it too.
      let skipInvitationId = change.answeredInvitationId;
      do {
        state.rerun = false;
        const event = this.deps.eventRepo.findById(change.eventId, change.userId);
        if (!event) return;
        await refreshInvitationCards(event, this.deps, skipInvitationId);
        skipInvitationId = undefined;
      } while (state.rerun);
    } finally {
      this.inFlight.delete(change.eventId);
    }
  }
}

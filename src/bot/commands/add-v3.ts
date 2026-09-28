// src/bot/commands/add-v3.ts
//
// GH-652's full-field /add path: when `DIALOGUE_V3_ENABLED` is on, a fully specified command
// (title + time/all-day, optionally people + place) creates the event in one turn with zero
// LLM calls, reading the shared `event.create` registration (src/services/operations/
// registry.ts) instead of a third bespoke parser. An incomplete command still falls through to
// the existing, unmodified add-event.scene.ts wizard (see add.ts) — this module only ever
// ADDS the one-shot fast path; it never replaces or narrows what the legacy wizard already
// does, and is entirely inert when `enabled` is false (add.ts's existing behavior is
// byte-identical with `dialogueV3` omitted).
//
// Reuses, never reimplements: `eventService.createEvent` (the same sanctioned entry point
// add-event.scene.ts uses), `applyDefaultDuration` (same default-duration rule), and the same
// confirmation-card formatters (`formatEventDetail`/`eventActionsKeyboard`/`t().event_created`)
// so a v3-created event's receipt looks identical to a wizard-created one.

import { t } from '../../config/constants.ts';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { ParticipantRepository } from '../../database/repositories/participant.repository.ts';
import type { User } from '../../database/types.ts';
import { type CalendarDay, resolveWallInstant } from '../../services/calendar/wall-clock.ts';
import { parseFullField } from '../../services/dialogue/full-field-parser.ts';
import type { PeopleResolver, PlaceResolver } from '../../services/dialogue/resolvers.ts';
import { checkReadiness } from '../../services/dialogue/session-machine.ts';
import { type EventCreateDraft, emptyDraft } from '../../services/dialogue/v3-types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { getOperation } from '../../services/operations/registry.ts';
import { escapeHtml, splitMessage } from '../../utils/telegram.ts';
import { eventActionsKeyboard } from '../keyboards.ts';
import { applyDefaultDuration } from '../scenes/add-event.scene.ts';
import type { BotCommandContext } from '../types.ts';

export interface DialogueV3AddDeps {
  readonly enabled: boolean;
  readonly eventService: EventService;
  readonly participantRepo?: ParticipantRepository;
  readonly actionLogRepo?: ActionLogRepository;
  readonly peopleResolver: PeopleResolver;
  readonly placeResolver: PlaceResolver;
  /** Injected for determinism in tests; defaults to `new Date()`. */
  readonly now?: () => Date;
}

/**
 * `handled: true` means this module already produced the whole user-visible result (created
 * the event and sent its card) — the caller MUST return without entering the legacy wizard.
 * `handled: false` means the caller should proceed with its existing flow; `seed` carries
 * whatever this pass DID resolve (a strict improvement over the legacy suffix scan, since it
 * reads the GH-650-fixed shared parser) so the wizard doesn't re-ask for a title/time answer
 * the full-field parser already found.
 */
export type FullFieldAddOutcome =
  | { readonly handled: true }
  | { readonly handled: false; readonly seed: { readonly title?: string; readonly startAt?: string } };

/** Local calendar-midnight instant for an all-day boundary; falls back to a UTC-literal midnight on the rare DST-gap edge (never thrown, never silently mis-dated). */
function localMidnightInstant(isoDay: string, timezone: string): string {
  const [y, m, d] = isoDay.split('-').map(Number) as [number, number, number];
  const day: CalendarDay = { y, m, d };
  const resolved = resolveWallInstant(day, 0, 0, timezone);
  if (resolved.kind === 'unique') return new Date(resolved.ms).toISOString();
  if (resolved.kind === 'fold') return new Date(resolved.instants[0].ms).toISOString();
  return `${isoDay}T00:00:00.000Z`;
}

export async function tryFullFieldAdd(
  ctx: BotCommandContext,
  user: User,
  timezone: string,
  groupId: number | null,
  input: string,
  deps: DialogueV3AddDeps,
): Promise<FullFieldAddOutcome> {
  if (!deps.enabled) return { handled: false, seed: {} };
  // Defensive: the registry is registered at module load; a missing registration means this
  // slice's own setup is broken, not a reason to guess at fields — abstain to the legacy path.
  if (!getOperation('event.create')) return { handled: false, seed: {} };

  const parseResult = parseFullField(input, {
    timezone,
    now: deps.now ? deps.now() : new Date(),
    actorId: user.telegram_id,
    peopleResolver: deps.peopleResolver,
    placeResolver: deps.placeResolver,
  });

  const draft: EventCreateDraft = {
    ...emptyDraft(groupId !== null ? 'group' : 'personal', groupId !== null ? groupId : undefined),
    ...parseResult.patch,
    people: parseResult.patch.people ?? [],
  };

  const readiness = checkReadiness(draft, parseResult.fuzzyPeople);
  const seed = {
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.schedule?.kind === 'timed' ? { startAt: draft.schedule.startAt } : {}),
  };
  if (!readiness.ready || !draft.title || !draft.schedule) return { handled: false, seed };

  const startAt =
    draft.schedule.kind === 'timed' ? draft.schedule.startAt : localMidnightInstant(draft.schedule.startDate, timezone);
  const endAt =
    draft.schedule.kind === 'timed'
      ? applyDefaultDuration(draft.schedule.startAt, user.default_event_duration_minutes ?? 60)
      : localMidnightInstant(draft.schedule.endDateExclusive, timezone);

  const event = deps.eventService.createEvent({
    user_id: user.telegram_id,
    title: draft.title,
    start_at: startAt,
    end_at: endAt,
    all_day: draft.schedule.kind === 'all_day',
    timezone,
    location: draft.place?.label,
    ...(groupId !== null ? { owner_type: 'group' as const, group_id: groupId, created_by: user.telegram_id } : {}),
  });

  for (const person of draft.people) {
    if (person.telegramId) deps.participantRepo?.add(event.id, person.telegramId, 'pending', 'attendee');
  }

  deps.actionLogRepo?.insert({
    user_id: user.telegram_id,
    chat_id: Number(ctx.chatId ?? user.telegram_id),
    action_type: 'command',
    action_name: 'create_event_v3',
    input_summary: draft.title,
    result_summary: `id: ${event.id}`,
    target_event_id: event.id,
    metadata: JSON.stringify({ startAt, endAt, allDay: draft.schedule.kind === 'all_day' }),
  });

  const receipt = splitMessage(
    `${t(ctx.lang).event_created(escapeHtml(draft.title))}\n\n${formatEventDetail(event, timezone, ctx.lang)}`,
    4000,
    'HTML',
  );
  for (const [index, chunk] of receipt.entries()) {
    await ctx.send(chunk, {
      parse_mode: 'HTML',
      ...(index === receipt.length - 1 ? { reply_markup: eventActionsKeyboard(event.id, ctx.lang) } : {}),
    });
  }

  return { handled: true };
}

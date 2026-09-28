// src/bot/pipeline/dialogue-v3-layer.ts
//
// GH-652's natural-text entry adapter: the SAME operation registry, full-field parser and
// session machine `/add` uses (add-v3.ts), driven from plain chat text instead of a slash
// command. Placed after IntentMatcherLayer (an approved custom intent still wins) and before
// AiAgentLayer (message.handler.ts), so returning `{ handled: false }` — a starter phrase this
// closed grammar doesn't recognize, or a continuation turn that resolved nothing — falls
// through to the existing AI agent exactly once, per the design brief's "unmatched complex
// input hands off to the existing AI path ONCE; local invalid/ambiguity does not invoke LLM."
// Entirely inert (never constructed) unless `DIALOGUE_V3_ENABLED` is on — see src/bot/index.ts.

import { t } from '../../config/constants.ts';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type {
  DialogueSessionKey,
  DialogueSessionRepository,
} from '../../database/repositories/dialogue-session.repository.ts';
import type { ParticipantRepository } from '../../database/repositories/participant.repository.ts';
import type { User } from '../../database/types.ts';
import { type CalendarDay, resolveWallInstant } from '../../services/calendar/wall-clock.ts';
import { parseFullField } from '../../services/dialogue/full-field-parser.ts';
import type { PeopleResolver, PlaceResolver } from '../../services/dialogue/resolvers.ts';
import { checkReadiness, nextQuestion } from '../../services/dialogue/session-machine.ts';
import { type DialogueV3Session, type EventCreateDraft, emptyDraft } from '../../services/dialogue/v3-types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { escapeHtml, splitMessage } from '../../utils/telegram.ts';
import { eventActionsKeyboard } from '../keyboards.ts';
import type { BotCommandContext } from '../types.ts';
import type { GroupContext, PipelineResult } from './types.ts';

export interface DialogueV3LayerDeps {
  readonly enabled: boolean;
  readonly dialogueSessions: DialogueSessionRepository;
  readonly eventService: EventService;
  readonly participantRepo?: ParticipantRepository;
  readonly actionLogRepo?: ActionLogRepository;
  readonly peopleResolver: PeopleResolver;
  readonly placeResolver: PlaceResolver;
  readonly now?: () => Date;
}

// Closed starter-verb lexicon, RU+EN — a leading trigger word is what decides "this message
// starts an event.create draft", never a network classifier (design: "Laya ... remains
// optional/unqualified; do not add mandatory network classification").
const STARTER_VERBS: ReadonlySet<string> = new Set([
  'сделай',
  'создай',
  'запланируй',
  'добавь',
  'schedule',
  'add',
  'create',
]);

const CANCEL_WORDS: ReadonlySet<string> = new Set(['cancel', 'отмена', 'отменить']);

function firstWord(text: string): string {
  return text.trim().toLowerCase().split(/\s+/)[0] ?? '';
}

function localMidnightInstant(isoDay: string, timezone: string): string {
  const [y, m, d] = isoDay.split('-').map(Number) as [number, number, number];
  const day: CalendarDay = { y, m, d };
  const resolved = resolveWallInstant(day, 0, 0, timezone);
  if (resolved.kind === 'unique') return new Date(resolved.ms).toISOString();
  if (resolved.kind === 'fold') return new Date(resolved.instants[0].ms).toISOString();
  return `${isoDay}T00:00:00.000Z`;
}

async function sendQuestion(ctx: BotCommandContext, field: string, lang: 'en' | 'ru'): Promise<void> {
  const prompts: Record<string, { en: string; ru: string }> = {
    title: { en: 'What should I call this event?', ru: 'Как назвать событие?' },
    schedule: { en: 'What time? (or "all day")', ru: 'Во сколько? (или "весь день")' },
  };
  const prompt = prompts[field];
  await ctx.send(prompt ? prompt[lang] : field);
}

async function executeDraft(
  ctx: BotCommandContext,
  user: User,
  draft: EventCreateDraft,
  timezone: string,
  deps: DialogueV3LayerDeps,
): Promise<void> {
  if (!draft.title || !draft.schedule) return;
  const startAt =
    draft.schedule.kind === 'timed' ? draft.schedule.startAt : localMidnightInstant(draft.schedule.startDate, timezone);
  const endAt =
    draft.schedule.kind === 'timed' ? undefined : localMidnightInstant(draft.schedule.endDateExclusive, timezone);

  const event = deps.eventService.createEvent({
    user_id: user.telegram_id,
    title: draft.title,
    start_at: startAt,
    end_at: endAt,
    all_day: draft.schedule.kind === 'all_day',
    timezone,
    location: draft.place?.label,
    ...(draft.scope === 'group' && draft.groupId
      ? { owner_type: 'group' as const, group_id: draft.groupId, created_by: user.telegram_id }
      : {}),
  });
  for (const person of draft.people) {
    if (person.telegramId) deps.participantRepo?.add(event.id, person.telegramId, 'pending', 'attendee');
  }
  deps.actionLogRepo?.insert({
    user_id: user.telegram_id,
    chat_id: Number(ctx.chatId ?? user.telegram_id),
    action_type: 'command',
    action_name: 'create_event_v3_natural',
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
}

function mergeDraft(base: EventCreateDraft, patch: Partial<EventCreateDraft>): EventCreateDraft {
  return {
    ...base,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
    ...(patch.people && patch.people.length > 0 ? { people: [...base.people, ...patch.people] } : {}),
    ...(patch.place !== undefined ? { place: patch.place } : {}),
  };
}

export function createDialogueV3Layer(deps: DialogueV3LayerDeps) {
  return async (
    ctx: BotCommandContext,
    messageText: string,
    extra?: { groupContext?: GroupContext },
  ): Promise<PipelineResult> => {
    if (!deps.enabled) return { handled: false };
    const user = ctx.dbUser;
    if (!user) return { handled: false };
    const key: DialogueSessionKey = {
      chatId: Number(ctx.chatId ?? user.telegram_id),
      userId: user.telegram_id,
      topicId: extra?.groupContext?.topicThreadId ?? 0,
    };
    const timezone = user.timezone;

    const existing = deps.dialogueSessions.get(key);
    if (existing && existing.status === 'collecting') {
      if (CANCEL_WORDS.has(messageText.trim().toLowerCase())) {
        deps.dialogueSessions.delete(key);
        await ctx.send(t(ctx.lang).cancelled);
        return { handled: true };
      }
      const parseResult = parseFullField(messageText, {
        timezone,
        now: deps.now ? deps.now() : new Date(),
        actorId: user.telegram_id,
        peopleResolver: deps.peopleResolver,
        placeResolver: deps.placeResolver,
      });
      // A turn only counts as progress when it actually addresses the field we're waiting on
      // (or resolves people/place, which are never pending but still welcome) — a bare leftover
      // title-shaped string (parseFullField always fills `patch.title` from whatever it didn't
      // recognize) must NOT count as "answered the time question" just because text exists.
      const addressedPendingField =
        existing.pendingField === 'schedule'
          ? parseResult.timeResolution !== null
          : existing.pendingField === 'title'
            ? Boolean(parseResult.patch.title)
            : true;
      const resolvedSomething =
        addressedPendingField ||
        Boolean(parseResult.patch.people?.length) ||
        Boolean(parseResult.patch.place) ||
        parseResult.fuzzyPeople.length > 0 ||
        parseResult.unresolvedPeopleNames.length > 0;
      if (!resolvedSomething) {
        // This turn's answer doesn't fit the closed grammar for what we're waiting on — hand off
        // to the existing AI path exactly once (return handled:false, AiAgentLayer is the next
        // layer). The typed payload for that handoff (buildAiHandoffPayload, ai-handoff.ts) is
        // built and passed to AgentContextBuilder by GH-656's own wiring, not duplicated here.
        deps.dialogueSessions.set(key, { ...existing, status: 'handed_off', updatedAt: Date.now() });
        return { handled: false };
      }
      const draft = mergeDraft(existing.draft, parseResult.patch);
      const readiness = checkReadiness(draft, parseResult.fuzzyPeople);
      if (readiness.ready) {
        deps.dialogueSessions.delete(key);
        await executeDraft(ctx, user, draft, timezone, deps);
        return { handled: true };
      }
      const question = nextQuestion(draft);
      const now = Date.now();
      const session: DialogueV3Session = {
        ...existing,
        draft,
        pendingField: question?.field ?? null,
        updatedAt: now,
      };
      deps.dialogueSessions.set(key, session);
      if (question) await sendQuestion(ctx, question.field, ctx.lang);
      return { handled: true };
    }

    if (firstWord(messageText) === '' || !STARTER_VERBS.has(firstWord(messageText))) return { handled: false };

    const parseResult = parseFullField(messageText, {
      timezone,
      now: deps.now ? deps.now() : new Date(),
      actorId: user.telegram_id,
      peopleResolver: deps.peopleResolver,
      placeResolver: deps.placeResolver,
    });
    const draft: EventCreateDraft = {
      ...emptyDraft('personal'),
      ...parseResult.patch,
      people: parseResult.patch.people ?? [],
    };
    const readiness = checkReadiness(draft, parseResult.fuzzyPeople);
    if (readiness.ready) {
      await executeDraft(ctx, user, draft, timezone, deps);
      return { handled: true };
    }
    const question = nextQuestion(draft);
    const now = Date.now();
    const session: DialogueV3Session = {
      version: 3,
      sessionId: crypto.randomUUID(),
      actorId: user.telegram_id,
      chatId: key.chatId,
      topicId: key.topicId,
      operation: 'event.create',
      draft,
      pendingField: question?.field ?? null,
      status: 'collecting',
      createdAt: now,
      updatedAt: now,
      sourceText: messageText,
    };
    deps.dialogueSessions.set(key, session);
    if (question) await sendQuestion(ctx, question.field, ctx.lang);
    return { handled: true };
  };
}

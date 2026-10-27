// src/bot/scenes/edit-value.scene.ts
import { Scene } from '@gramio/scenes';
import { addMinutes } from 'date-fns';
import { type Lang, t } from '../../config/constants.ts';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import { CLEARED_LOCATION } from '../../database/repositories/event.repository.ts';
import type { CalendarEvent, UpdateEventData, User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { withMapButton } from '../../services/location/event-venue.ts';
import type { LocationVerificationService } from '../../services/location/location-verification-service.ts';
import { parseDuration, parseSimpleDate } from '../../utils/date.ts';
import { botLogger } from '../../utils/logger.ts';
import { eventActionsKeyboard, sceneHelpKeyboard } from '../keyboards.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';

interface EditValueParams {
  eventId: number;
  field: string;
  chatId: number;
  messageId: number;
}

const EDIT_PROMPTS: Record<string, Record<string, string>> = {
  title: { en: 'Send new title:', ru: 'Отправьте новое название:' },
  time: { en: 'Send new date/time (e.g., "tomorrow 15:00"):', ru: 'Отправьте новую дату/время:' },
  duration: {
    en: 'Send duration (e.g., "1h 30m") or "clear" to remove:',
    ru: 'Отправьте длительность (напр. "1ч 30м") или "clear" для удаления:',
  },
  description: {
    en: 'Send new description (or "clear" to remove):',
    ru: 'Отправьте описание (или "clear" для удаления):',
  },
  location: {
    en: 'Send new location (or "clear" to remove):',
    ru: 'Отправьте место (или "clear" для удаления):',
  },
};

type EditOutcome =
  | { kind: 'ok'; data: UpdateEventData }
  | { kind: 'reject'; message: string }
  | { kind: 'missing_event' };

const accept = (data: UpdateEventData): EditOutcome => ({ kind: 'ok', data });
const reject = (message: string): EditOutcome => ({ kind: 'reject', message });

function timeEdit(text: string, timezone: string, lang: Lang): EditOutcome {
  const parsed = parseSimpleDate(text, timezone);
  if (!parsed) return reject(lang === 'ru' ? 'Не могу разобрать дату.' : "Can't parse that date.");
  return accept({ start_at: parsed.toISOString() });
}

function durationEdit(text: string, loadEvent: () => CalendarEvent | null, lang: Lang): EditOutcome {
  if (text.toLowerCase() === 'clear') return accept({ end_at: null });
  const mins = parseDuration(text);
  if (!mins) {
    return reject(
      lang === 'ru' ? 'Не могу разобрать. Примеры: 1ч, 30м, 1ч 30м' : "Can't parse. Examples: 1h, 30m, 1h 30m",
    );
  }
  const event = loadEvent();
  if (!event) return { kind: 'missing_event' };
  return accept({ end_at: addMinutes(new Date(event.start_at), mins).toISOString() });
}

function locationEdit(text: string): UpdateEventData {
  return text.toLowerCase() === 'clear' ? { ...CLEARED_LOCATION } : { location: text };
}

function resolveEdit(
  field: string,
  text: string,
  user: User,
  lang: Lang,
  event: () => CalendarEvent | null,
): EditOutcome {
  switch (field) {
    case 'title':
      return accept({ title: text });
    case 'time':
      return timeEdit(text, user.timezone, lang);
    case 'duration':
      return durationEdit(text, event, lang);
    case 'description':
      return accept({ description: text.toLowerCase() === 'clear' ? null : text });
    case 'location':
      return accept(locationEdit(text));
    default:
      return accept({});
  }
}

export function createEditValueScene(
  eventService: EventService,
  userComposer: UserResolverComposer,
  actionLogRepo?: ActionLogRepository,
  locationVerification?: Pick<LocationVerificationService, 'verifyEventLocation' | 'refreshInvitationCards'>,
) {
  return (
    new Scene('edit_value')
      .params<EditValueParams>()
      // extend() AFTER params() — params() uses Modify which replaces Derives.global
      .extend(userComposer)
      // onEnter sends prompt — because scene is entered from callback_query
      // but step 0 is "message", so firstTime won't fire on entry
      .onEnter(async (context) => {
        const { lang } = context;
        const params = context.scene.params;
        await context.send(EDIT_PROMPTS[params.field]?.[lang] ?? 'Send new value:');
      })
      .step('message', async (context) => {
        const { lang, dbUser: user } = context;
        if (!user) {
          await context.scene.exit();
          return;
        }

        const { eventId, field, chatId, messageId } = context.scene.params;
        const text = context.text;
        if (!text) return;

        const outcome = resolveEdit(field, text, user, lang, () => eventService.getEvent(eventId, user.telegram_id));
        if (outcome.kind === 'reject') {
          await context.send(outcome.message, { reply_markup: sceneHelpKeyboard(lang) });
          return;
        }
        if (outcome.kind === 'missing_event') {
          await context.scene.exit();
          await context.send(t(lang).something_wrong);
          return;
        }
        const updateData = outcome.data;

        // Delivered invitation cards show the location as it was before this edit
        const before = field === 'location' ? eventService.getEvent(eventId, user.telegram_id) : null;
        const updated = eventService.updateEvent(eventId, user.telegram_id, updateData);

        actionLogRepo?.insert({
          user_id: user.telegram_id,
          chat_id: chatId,
          action_type: 'scene',
          action_name: `edit_event_${field}`,
          message_id: context.id,
          input_summary: text,
          result_summary: updated ? `updated ${field}` : 'failed',
          target_event_id: eventId,
          metadata: JSON.stringify(updateData),
          success: !!updated,
        });

        // Cards before the question, whose answer re-renders them again (see update_event)
        if (updated && before && locationVerification) {
          await locationVerification.refreshInvitationCards(before, updated);
        }

        // Same verification and clarification flow as the AI update_event tool.
        if (updated && updateData.location && locationVerification) {
          locationVerification
            .verifyEventLocation(updated, user)
            .catch((err) => botLogger.error({ err, eventId }, 'Background location verification failed'));
        }

        await context.scene.exit();

        if (updated) {
          const detail = formatEventDetail(updated, user.timezone, lang);
          const editText = `${t(lang).event_updated(updated.title)}\n\n${detail}`;
          await context.bot.api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: editText,
            parse_mode: 'HTML',
            reply_markup: withMapButton(eventActionsKeyboard(eventId, lang), updated, lang),
          });
        } else {
          await context.send(t(lang).something_wrong);
        }
      })
  );
}

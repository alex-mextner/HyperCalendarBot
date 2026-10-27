// src/config/constants/messages/ru/agent-status.ts
// AI-agent failure, degraded-mode, timeout and unverified-answer notices, plus rate limiting.

import { RU_AGENT_ERROR_PHRASES, RU_AI_COMMANDS_HINT } from '../../agent-phrases.ts';
import { pickPhrase } from '../../text-helpers.ts';

export const ruAgentStatus = {
  agent_error: (exclude?: string) => pickPhrase(RU_AGENT_ERROR_PHRASES, exclude),
  ai_degraded: `🔧 ИИ недоступен — своими словами ответить не смогу.\n\n${RU_AI_COMMANDS_HINT}`,
  ai_still_down: (next: 'retry' | 'resend' | 'unsure') =>
    next === 'retry'
      ? '🔧 Пока не сделал: ИИ всё ещё недоступен. Повторю этот запрос сам чуть позже.'
      : next === 'unsure'
        ? '🔧 Пока не сделал: ИИ всё ещё недоступен. Если не отвечу через пару минут — пришли запрос ещё раз.'
        : '🔧 Не сделал: ИИ всё ещё недоступен. Пришли запрос ещё раз через пару минут.',
  agent_give_up: (promised: boolean) =>
    promised
      ? `🔧 Обещал вернуться — но ИИ так и не поднялся. Разрабы уже смотрят.\n\n${RU_AI_COMMANDS_HINT}`
      : `🔧 ИИ всё ещё недоступен — разрабы уже смотрят.\n\n${RU_AI_COMMANDS_HINT}`,
  agent_restarting: (willRetry: boolean) =>
    willRetry
      ? '🔄 Перезапускаюсь на обновление — отвечу на это через минуту.'
      : '🔄 Перезапускаюсь на обновление — этот запрос не выполнен, повтори его через минуту.',
  agent_restarting_unconfirmed:
    '🔄 Перезапускаюсь на обновление — если не отвечу на это через пару минут, повтори запрос.',
  agent_timeout: '⚠️ Что-то долго думаю — прерываю.',
  ai_response_blocked: 'Провайдер остановил ответ. Я не буду автоматически повторять этот запрос.',
  ai_unanswered: '⚠️ Не получилось ответить — повтори вопрос.',
  ai_unanswered_writes: (writes: string) => `⚠️ Ответ не получился — вот что сделано:\n${writes}`,
  weekdayDateMismatch: {
    fact: (date: string, actual: string, said: string, nearest: string) =>
      `${date} — ${actual}, а не ${said}; ${said} — ${nearest}`,
    notice: (facts: readonly string[]) =>
      `⚠️ ${facts.join('\n')}\nВ ответе перепутались дни недели и даты, поэтому он не отправлен. Напиши, какой день нужен, — проверю заново.`,
  },
  unverified_answer: 'Не удалось проверить ответ по данным календаря. Открой /today или назови нужную дату.',
  unverified_answer_with_events: (events: string) =>
    `Что нашлось в календаре:\n${events}\n\nСвой ответ по этим данным проверить не удалось, поэтому показываю их как есть.`,
  unverified_more_events: (count: number) => `… и ещё ${count}`,
  rate_limited: 'Слишком много сообщений, подождите.',
  stale_update_skipped: '⏳ Пропустил твоё сообщение, пока перезапускался — повтори, если ещё актуально.',
} as const;

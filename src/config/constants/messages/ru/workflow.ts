// src/config/constants/messages/ru/workflow.ts
// Intent-workflow outcome text, day headings and write-outcome (delivery/attempt) wording.

import { capitalize } from '../../text-helpers.ts';

export const ruWorkflow = {
  intentWorkflow: {
    failedUnchanged: 'Не получилось выполнить, ничего не изменилось. Попробуй ещё раз или скажи иначе.',
    appliedIncomplete:
      'Изменение применено, но остальную часть запроса выполнить не удалось. Проверь календарь: повторять я не буду.',
    outcomeUnknown:
      'Не могу подтвердить, выполнилось ли это. Проверь календарь, прежде чем повторять запрос: сам я его повторять не буду.',
    weekdaysShort: ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'],
    dayHeading: (relative: string | null, weekday: string, day: string, month: string) =>
      relative ? `${capitalize(relative)}, ${weekday} ${day}.${month}` : `${capitalize(weekday)} ${day}.${month}`,
  },
  writeOutcomes: {
    completed: 'Выполнено',
    notCompleted: 'Не выполнено',
    uncertain: 'Результат неизвестен',
    failed: 'попытка не удалась; выполнение не подтверждено',
    notApplied: 'запрос отклонён до внесения изменений',
    skipped: 'пропущено; новое изменение не выполнялось',
    invitationDelivered: 'Приглашение доставлено',
    invitationManual: 'Приглашение создано, но не доставлено. Перешли ссылку из личного чата.',
    invitationFailed: 'Приглашение создано, но не доставлено.',
    attendanceDeclined: 'Участие отклонено; событие сохранено.',
    interrupted: 'Запрос прерван. Часть действий могла уже выполниться; автоматического повтора не будет.',
    attempts:
      'Это отдельные попытки выполнения, а не список невыполненных запросов. Последующие успешные попытки показаны отдельно.',
    write: 'Изменение',
    field: 'поле',
    attempt: (n: number) => `Попытка ${n}`,
    spokenQuestion: (question: string, options: string) => `${question} Варианты: ${options}`,
    operations: {
      delete_event: 'Удаление события',
      update_event: 'Изменение события',
      create_event: 'Создание события',
      send_invitation: 'Отправка приглашения',
    },
    fields: {
      title: 'название',
      start_at: 'начало',
      end_at: 'окончание',
      description: 'описание',
      location: 'место',
      all_day: 'весь день',
      timezone: 'часовой пояс',
      category: 'категория',
      location_abstract: 'тип места',
      recurrence_rule: 'повторение',
      recurrence_end_at: 'конец повторения',
      reminder_overrides: 'напоминания',
    },
  },
} as const;

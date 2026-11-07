// src/config/constants/messages/ru/workflow.ts
// Intent-workflow outcome text, day headings and write-receipt wording.

import { ruPlural } from '../../../../services/event/formatters.ts';
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
    // What the model reads back from send_invitation: one invitation, said once.
    invitationDelivered: 'Приглашение доставлено',
    invitationManual: 'Приглашение создано, но не доставлено. Перешли ссылку из личного чата.',
    invitationFailed: 'Приглашение создано, но не доставлено.',
    interrupted: 'Запрос прерван. Часть действий могла уже выполниться; автоматического повтора не будет.',
    receipt: {
      intro: 'Сделано в календаре:',
      created: (title: string, when: string) => `Создано: «${title}» — ${when}`,
      alreadyThere: (title: string, when: string) => `Уже есть в календаре: «${title}» — ${when}`,
      updated: (title: string, when: string) => `Изменено: «${title}» — теперь ${when}`,
      deleted: (title: string, when: string) => `Удалено: «${title}» (было ${when})`,
      allDay: 'весь день',
      outro: 'Это данные самого календаря. Свой текстовый ответ проверить не удалось, поэтому не отправляю его.',
    },
    spokenQuestion: (question: string, options: string) => `${question} Варианты: ${options}`,
    // The receipt that replaces the model's text when a run had failed, skipped or unconfirmed writes.
    anEvent: 'событие',
    theEvent: 'событие',
    eventNamed: (title: string, when: string | null) => (when ? `событие «${title}» (${when})` : `событие «${title}»`),
    eventTitle: (title: string) => `«${title}»`,
    change: 'изменение',
    calendarOf: (name: string) => `календарь: ${name}`,
    otherCalendar: 'другой календарь',
    delegatedCalendar: 'чужой календарь, который ты ведёшь как секретарь',
    changedFields: (fields: readonly string[]) => `, поля: ${fields.join(', ')}`,
    nothingChanged: 'ничего не изменилось',
    skipped: 'пропущено, повторно не выполнялось',
    repeatUnknown: (event: string | null) =>
      event
        ? `Повторное создание не удалось подтвердить: ${event}. Проверь календарь на дубль.`
        : 'Повторное создание события не удалось подтвердить. Проверь календарь на дубль.',
    retriedAfterUnknown: 'Повторная попытка удалась, но первая могла тоже сработать: проверь календарь на дубль.',
    attendanceDeclined: (title: string | null) =>
      title
        ? `Участие в «${title}» отклонено; событие осталось в календаре.`
        : 'Участие отклонено; событие осталось в календаре.',
    retry: 'Скажи, что повторить: уже выполненное я повторять не буду.',
    checkFirst: 'Проверь календарь, прежде чем повторять: сам я ничего не повторяю.',
    people: (names: readonly string[], unnamed: number) => {
      const count = `${unnamed} ${ruPlural(unnamed, 'человек', 'человека', 'человек')}`;
      if (names.length === 0) return count;
      return unnamed === 0 ? names.join(', ') : `${names.join(', ')} и ещё ${count}`;
    },
    invitations: {
      sent: (n: number, event: string, who: string) =>
        n === 1 ? `Приглашение на ${event} отправлено: ${who}.` : `Приглашения на ${event} отправлены: ${who}.`,
      created: (n: number, event: string, who: string) =>
        n === 1 ? `Приглашение на ${event} создано: ${who}.` : `Приглашения на ${event} созданы: ${who}.`,
      manual: (n: number, event: string, who: string) =>
        n === 1
          ? `Приглашение на ${event} создано, но не доставлено: ${who}. Перешли ссылку из личного чата.`
          : `Приглашения на ${event} созданы, но не доставлены: ${who}. Перешли ссылки из личного чата.`,
      undelivered: (n: number, event: string, who: string) =>
        n === 1
          ? `Приглашение на ${event} создано, но не доставлено: ${who}.`
          : `Приглашения на ${event} созданы, но не доставлены: ${who}.`,
      rejected: (n: number, event: string, who: string) =>
        n === 1 ? `Приглашение на ${event} не отправлено: ${who}.` : `Приглашения на ${event} не отправлены: ${who}.`,
      unknown: (n: number, event: string, who: string) =>
        n === 1
          ? `Не удалось подтвердить, дошло ли приглашение на ${event}: ${who}.`
          : `Не удалось подтвердить, дошли ли приглашения на ${event}: ${who}.`,
      skipped: (n: number, event: string, who: string) =>
        n === 1
          ? `Приглашение на ${event} пропущено, повторно не отправлялось: ${who}.`
          : `Приглашения на ${event} пропущены, повторно не отправлялись: ${who}.`,
    },
    // A create that found its event already saved (same event, nothing written by this run).
    alreadyThere: 'Уже есть в календаре',
    operations: {
      create_event: {
        done: 'Создано',
        notDone: 'Не создано',
        unknown: 'Не удалось подтвердить создание',
      },
      update_event: {
        done: 'Изменено',
        notDone: 'Не изменено',
        unknown: 'Не удалось подтвердить изменение',
      },
      delete_event: {
        done: 'Удалено',
        notDone: 'Не удалено',
        unknown: 'Не удалось подтвердить удаление',
      },
    },
    otherWrite: {
      done: 'Выполнено',
      notDone: 'Не выполнено',
      unknown: 'Не удалось подтвердить выполнение',
    },
    field: 'поле',
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

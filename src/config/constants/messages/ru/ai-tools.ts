// src/config/constants/messages/ru/ai-tools.ts
// AI tool-result wording (calendar reads/writes, participants, notifications).

import { ruPlural } from '../../../../services/event/formatters.ts';
import { capitalize } from '../../text-helpers.ts';

export const ruAiTools = {
  aiTools: {
    memory: {
      saved: 'Запомнил.',
      storageUnavailable: 'Сейчас не могу ничего запомнить — хранилище памяти недоступно.',
      empty: 'Запоминать тут нечего.',
      // Numbers here name no noun on purpose: ruPlural lives in formatters.ts,
      // which imports this file, so importing it back would close a cycle.
      tooLong: (length: number, limit: number) =>
        `Этот факт слишком длинный, чтобы его хранить — длина ${length}, лимит ${limit}. Скажи суть одним коротким предложением или раздели на несколько фактов.`,
    },
    history: {
      notFound: 'История не найдена.',
    },
    actionLog: {
      notFound: 'Записей в логе действий не найдено.',
    },
    meta: {
      noHolidays: 'Праздников не найдено. Возможно, у тебя не настроены подписки на страны.',
      holidaysList: (lines: string) => `Праздники:\n${lines}`,
      foundUser: (id: number, name: string) => `Пользователь найден: telegram_id=${id}, имя=${name}`,
      addressBookEmpty: 'Адресная книга пуста.',
      invitationLinkUnavailable:
        'Это приглашение недоступно твоему Telegram-аккаунту. Попроси отправителя проверить получателя.',
      recipientMissing: 'Выбери получателя (invitee_id или invitee_username).',
      recipientNotFound: (username: string) =>
        `@${username} не найден в Telegram. Проверь ник или выбери человека через Telegram.`,
      recipientResolveUnavailable:
        'Проверка username недоступна. Выбери сохранённый контакт или человека через Telegram.',
      recipientLookupFailed: (username: string) =>
        `Не удалось проверить @${username}. Выбери сохранённый контакт или человека через Telegram.`,
      contactDeleteRequiresTool: 'Изменение полей не удаляет контакт. Для удаления нужна отдельная операция.',
      contactDeleted: 'Контакт удалён из твоей адресной книги. События и приглашения не менял.',
      contactAlreadyAbsent: 'Такого контакта в твоей адресной книге нет. Ничего другого не менял.',
      contactsPrivateOnly: 'Открой нашу личную переписку, чтобы удалить контакт из адресной книги.',
      recipientNameAmbiguous:
        'Это похоже на имя сохранённого контакта, а не на указанный Telegram-ник. Выбери человека из контактов.',
      recipientUsernameUnconfirmed:
        'Не могу угадывать Telegram-ник по имени. Выбери сохранённый контакт или укажи точный @username.',
      userInfo: (details: string) => `Данные пользователя:\n${details}`,
      recipientConfirmButton: 'Подтвердить этот ID',
      recipientSavedProfile: (name: string, id: number) => `Сохранённый контакт: ${name} (ID ${id}).`,
      recipientResolvedProfile: (name: string, id: number) => `По username найден: ${name} (ID ${id}).`,
      recipientConfirmationSent: 'Отправил подтверждение получателя в личные сообщения.',
      recipientConfirmDetails: (id: number, username: string) =>
        `Нужно уточнить получателя. Указан Telegram ID: ${id}; подсказка username: ${username}. Эти данные могут относиться к разным аккаунтам. Подтверждай только если этот ID — нужный человек. Иначе выбери человека через список Telegram.`,
      recipientIdentityConflict:
        'ID и username получателя указывают на разных людей. Выбери нужного человека ещё раз; приглашение не создавал.',
      recipientUnverified:
        'Не могу проверить этого получателя. Выбери человека из контактов или через выбор пользователей Telegram; приглашение не создавал.',
      recipientContactRowId: 'Номер контакта в адресной книге — не Telegram ID; приглашение не создавал.',
      recipientContactWithoutTelegram: (name: string) =>
        `У контакта «${name}» нет привязанного Telegram-аккаунта. Выбери его через выбор пользователей Telegram; приглашение не создавал.`,
      contactsList: (lines: string) => `Контакты:\n${lines}`,
      contactSaved: (name: string) => `Контакт сохранён: ${name}`,
      contactFound: (data: string) => `Контакт найден: ${data}`,
      contactMatches: (lines: string) => `Совпадения контактов:\n${lines}`,
      contactUpdated: (label: string) => `Контакт обновлён: ${label}`,
      questionSent: 'Вопрос отправлен. Ожидаю ответа.',
      deleteConfirmHeader: (count: number) =>
        count === 1 ? 'Удалить это событие?' : `Удалить эти события (${count})?`,
      deleteConfirmPastNote: (count: number) =>
        `⚠️ Уже прошли: ${count}. Их удаляю, только если выбрать «Вкл. прошедшие».`,
      deletePastMark: 'уже прошло',
      deleteRecurringMark: 'повторяющаяся серия',
      deleteButton: (count: number) => `🗑 Удалить (${count})`,
      deleteUpcomingOnlyButton: (count: number) => `🗑 Только предстоящие (${count})`,
      deleteIncludingPastButton: (count: number) => `Вкл. прошедшие (${count})`,
      deletePastButton: (count: number) => `🗑 Удалить прошедшие (${count})`,
      deleteCancelButton: 'Отмена',
      deleteConfirmationSent: 'Подтверждение удаления отправлено. Жду нажатия кнопки.',
      deleteConfirmationSentToChat: 'Отправил список в наш чат. Нажми там кнопку, чтобы удалить.',
      deleteNeedsConfirmation: 'Не удалено: пользователь не подтвердил это событие в списке удаления от бота.',
      deleteTargetsNotFound: (ids: string) => `Не найдены или недоступны для удаления: ${ids}. Ничего не отправлено.`,
      deleteConfirmExpired: 'Это подтверждение больше не действует. Попроси удалить ещё раз.',
      deleteDone: (count: number) => `✅ Удалено: ${count}`,
      deleteKeptPast: (count: number) => `Прошедшие не тронуты: ${count}`,
      deleteFailed: (titles: string) => `⚠️ Не удалось удалить: ${titles}`,
      deleteCancelled: '❌ Отменено, ничего не удалено.',
      dayImageSent: (date: string) => `Картинка календаря за ${date} отправлена в чат.`,
      weekImageSent: (week: string) => `Календарь на ${week} — картинка в чате.`,
      monthImageSent: (month: string) => `Картинка месячного календаря за ${month} отправлена в чат.`,
      dayImageFailed: (date: string) => `Не удалось отрендерить или отправить картинку за ${date}.`,
      dayImageSentInstead: (date: string, requested: string) =>
        `Картинка календаря за ${date} отправлена в чат вместо прошедшего дня ${requested}: ${date} — ближайший предстоящий день с только что внесёнными изменениями.`,
      weekImageFailed: (weekStart: string) => `Не удалось отрендерить или отправить недельную картинку с ${weekStart}.`,
      monthImageFailed: (month: string) => `Не удалось отрендерить или отправить месячную картинку за ${month}.`,
      callQueued: 'Звонок поставлен в очередь. Ты получишь голосовой звонок в ближайшее время.',
      callQueueFailed: 'Не удалось запланировать звонок: очередь звонков недоступна. Звонка не будет.',
      callFailed: (text: string) => `📞 Не удалось дозвониться.\n\n${text}`,
      gcalNotConnected: 'Google Calendar не подключён. Ты можешь подключить его командой /connect_google.',
      gcalConnectedNoData: 'Google Calendar подключён, но данные календарей недоступны.',
      gcalConnectedHeader: 'Google Calendar подключён.',
      gcalCalendarsCount: (total: number, syncing: number) => `Календари: всего ${total}, синхронизируется ${syncing}.`,
      gcalNoCalendars: 'Google-календари не найдены. Возможно, синхронизация ещё идёт.',
      gcalList: (lines: string) => `Google-календари:\n${lines}`,
      userPickerSent: 'Форма выбора участников отправлена. Ожидаю ответа.',
      sceneResumed: 'Продолжай заполнение с того места, где остановился.',
      sceneCancelled: 'Заполнение отменено.',
      tableSent: (title: string) => `Таблица «${title}» отправлена в чат.`,
      tableFailed: (title: string) => `Не удалось отрендерить или отправить таблицу «${title}».`,
      tableRenderingVoice: 'Загляни в чат — там таблица.',
      telegramConnectedStatus: 'Telegram-аккаунт подключён',
      telegramNotConnectedStatus: 'Telegram-аккаунт не подключён. Подключить: /connect_telegram',
    },
    slots: {
      noFreeSlots: 'Свободных окон нет — весь день занят.',
      invalidDate: 'Некорректная дата. Нужна реальная дата вида 2026-03-15.',
      freeSlots: (lines: string) => `Свободные слоты:\n${lines}`,
    },
    settings: {
      callsUpdated: 'Настройки звонков обновлены.',
      notificationsUpdated: (keys: string) => `Настройки уведомлений обновлены: ${keys}`,
      privacyUpdated: (lines: string) => `Настройки приватности обновлены: ${lines}`,
      voiceUpdated: (value: string) => `Настройки голоса обновлены: voice_response_enabled = ${value}`,
    },
    feedback: {
      feedbackSent: 'Отзыв отправлен разработчику. Ответ придёт в этот чат.',
    },
    events: {
      emptyAgenda: {
        calendar: {
          personal: 'в твоём календаре',
          group: 'в календаре этой группы',
          delegated: 'в выбранном календаре',
        },
        relativeDay: {
          yesterday: 'вчера',
          today: 'сегодня',
          tomorrow: 'завтра',
          dayAfterTomorrow: 'послезавтра',
        },
        dateTime: (date: string, time: string) => `${date} ${time}`,
        dayUpcoming: (relative: string | null, date: string, calendar: string) =>
          `На ${relative ? `${relative}, ${date},` : date} ${calendar} пока нет событий, которые начинаются в этот день.`,
        dayPast: (relative: string | null, date: string, calendar: string) =>
          `${relative ? `${capitalize(relative)}, ${date},` : date} ${calendar} не было событий, которые начинались в этот день.`,
        window: (relative: string | null, date: string, from: string, to: string, calendar: string) =>
          `${relative ? `${capitalize(relative)}, ${date},` : date} с ${from} до ${to} ${calendar} нет событий, которые начинаются в это время.`,
        windowSpan: (from: string, to: string, calendar: string) =>
          `С ${from} до ${to} ${calendar} нет событий, которые начинаются в это время.`,
        windowPast: (relative: string | null, date: string, from: string, to: string, calendar: string) =>
          `${relative ? `${capitalize(relative)}, ${date},` : date} с ${from} до ${to} ${calendar} не было событий, которые начинались в это время.`,
        windowSpanPast: (from: string, to: string, calendar: string) =>
          `С ${from} до ${to} ${calendar} не было событий, которые начинались в это время.`,
        rangeUpcoming: (from: string, to: string, calendar: string) =>
          `С ${from} по ${to} ${calendar} пока нет событий, которые начинаются в эти дни.`,
        rangePast: (from: string, to: string, calendar: string) =>
          `С ${from} по ${to} ${calendar} не было событий, которые начинались в эти дни.`,
        rangeCurrent: (from: string, to: string, calendar: string) =>
          `С ${from} по ${to} ${calendar} нет событий, которые начинаются в эти дни.`,
      },
      noEventsMatching: 'Событий по запросу не найдено.',
      noEventsMatchingScope: (scope: string) =>
        `Событий по запросу не найдено в ${scope === 'personal' ? 'личном' : 'групповом'} календаре. Попробуй поискать в ${scope === 'personal' ? 'групповом' : 'личном'}.`,
      noUpcomingEvents: 'Предстоящих событий нет.',
      upcomingEvents: (count: number, lines: string) => `Следующие ${count}:\n${lines}`,
      eventCreated: (parts: string) => `Событие создано: ${parts}`,
      eventUpdated: (parts: string) => `Событие обновлено: ${parts}`,
      eventDeleted: (title: string, id: number) => `Событие «${title}» (id: ${id}) удалено.`,
      eventDeclined: (id: number) => `Ты отклонил(а) общее событие (id: ${id}). Оно удалено из твоего календаря.`,
      snoozed: (title: string, minutes: number, newStart: string) =>
        `Событие «${title}» отложено на ${minutes} мин. Новое начало: ${newStart}`,
      notificationQueued: (count: number) =>
        `Уведомление поставлено в очередь для ${count} ${ruPlural(count, 'участника', 'участников', 'участников')}.`,
      participantUpdate: (eventTitle: string, senderName: string, message: string) =>
        `📅 Обновление по «${eventTitle}» от ${senderName}:\n${message}`,
      participantHint: (count: number) =>
        `. У этого события ${count} ${ruPlural(count, 'участник', 'участника', 'участников')} — уведоми их, если изменение существенное (инструмент notify_participants).`,
      locationAttached: (eventId: number) => `📍 Локация привязана к событию #${eventId}.`,
    },
    reminders: {
      noReminders: (title: string) => `Для «${title}» нет напоминаний.`,
      remindersSet: (title: string, descriptions: string) => `Напоминания для «${title}» установлены: ${descriptions}`,
      remindersDisabled: (title: string) => `Все напоминания для «${title}» отключены.`,
      remindersFor: (title: string, lines: string) => `Напоминания для «${title}»: ${lines}`,
      durationMin: (n: number) => `${n}мин`,
      durationHourMin: (h: number, m: number) => (m > 0 ? `${h}ч ${m}мин` : `${h}ч`),
      beforeDuration: (dur: string) => `за ${dur}`,
      noEventsForQuery: (query: string) => `По запросу «${query}» событий не найдено.`,
      noRemindersLabel: 'Без напоминаний',
      noRemindersFound: 'Напоминаний не найдено.',
    },
    sharing: {
      eventShared: (title: string, id: number, targetType: string, targetId: number) =>
        `Событие «${title}» опубликовано (id: ${id}, получатель: ${targetType} ${targetId}).`,
      invitationCreated: (invId: number, eventId: number, inviteeId: number) =>
        `Приглашение создано (id: ${invId}, событие: ${eventId}, приглашённый: ${inviteeId}). Уведомление отправляется в фоне.`,
      invitationCancelled: (id: number) => `Приглашение ${id} отменено.`,
      invitationReminderQueued: (userId: number) =>
        `Напоминание о приглашении поставлено в очередь (пользователь ${userId}). Уведомление отправляется в фоне.`,
      noInvitations: (title: string) => `Для события «${title}» нет приглашений.`,
      invitationsFor: (title: string, id: number, lines: string) => `Приглашения для «${title}» (id: ${id}):\n${lines}`,
      rsvpSelf: 'вы',
      rsvpStatuses: {
        pending: 'ожидается ответ',
        accepted: 'принято',
        declined: 'отклонено',
        maybe: 'возможно',
        cancelled: 'отменено',
        expired: 'истекло',
      },
      rsvpAttending: (count: number) => `идут (подтвердили): ${count}`,
      rsvpOrganizer: (userId: number | string) => `организатор: ${userId}`,
      rsvpInviteeLine: (userId: number | string, status: string, note: string) =>
        `приглашённый: ${userId}, статус: ${status}${note}`,
      rsvpMemberLine: (userId: number | string, status: string) => `  участник: ${userId}, статус: ${status}`,
      rsvpPersonalInviteNote: (inviteStatus: string) => ` (личное приглашение: ${inviteStatus})`,
      groupRsvpHeader: 'групповое приглашение — ответы участников:',
      groupRsvpNone: 'групповое приглашение: ответов участников пока нет',
      groupRsvpUnavailable: 'групповое приглашение: участники отвечают индивидуально (реестр участников недоступен)',
      noEventsToShare: (period: string) => `Нет видимых событий для публикации за ${period}.`,
      agendaShared: (period: string, targetType: string, targetId: number, count: number, lines: string) =>
        `Расписание (${period}) опубликовано для ${targetType} ${targetId} (${count} событий):\n${lines}`,
      visibilitySet: (title: string, id: number, visibility: string) =>
        `Видимость «${title}» (id: ${id}) изменена на «${visibility}».`,
      editProposalSubmitted: (id: number) =>
        `Предложение изменений отправлено (id: ${id}). Создатель события получит уведомление.`,
      deliveryFallbackWithLink: (eventTitle: string, invitee: string, url: string) =>
        `⚠️ Не удалось доставить приглашение для ${invitee} на «${eventTitle}» напрямую. Перешлите ссылку получателю: ${url}`,
      deliveryFallbackNoLink: (eventTitle: string, invitee: string) =>
        `⚠️ Не удалось доставить приглашение для ${invitee} на «${eventTitle}» напрямую.`,
      userSessionInvitation: (args: {
        title: string;
        dateLine: string;
        locationLine: string;
        descriptionLine: string;
        deepLink: string;
      }) =>
        `Приглашаю тебя на «${args.title}»\n📅 ${args.dateLine}${args.locationLine}${args.descriptionLine}\n\nПодробнее и ответить: ${args.deepLink}`,
    },
    birthdays: {
      created: (name: string, day: number, month: number) =>
        `День рождения создан: Д/р ${name} (${day}.${String(month).padStart(2, '0')})`,
      alreadyExists: (name: string, day: number, month: number) =>
        `День рождения ${name} уже есть: ${day}.${String(month).padStart(2, '0')}`,
      conflictError: (name: string, day: number, month: number) =>
        `Уже есть день рождения для ${name}: дата ${day}.${String(month).padStart(2, '0')}. Хочешь обновить?`,
    },
    scheduled: {
      noScheduledCalls: 'Запланированных вызовов нет.',
      noTriggers: 'Триггеров нет.',
      scheduleCreated: (id: string, message: string, when: string) =>
        `Запланировано (id: ${id}): «${message}» — ${when}`,
      scheduleCancelled: (id: string) => `Расписание ${id} отменено.`,
      triggerCreated: (id: string, topic: string, condition: string | null, action: string) =>
        `Триггер создан (id: ${id}): когда ${topic}${condition ? ` и (${condition})` : ''} → «${action}»`,
      triggerRemoved: (id: string) => `Триггер ${id} удалён.`,
    },
    location: {
      clarifyAddress: (title: string) => `📍 Уточни адрес для «${title}»:`,
      locationResolved: (title: string, address: string) => `📍 Адрес для «${title}» определён: ${address}`,
      noneOfThese: '🚫 Ничего из этого — оставить как написано',
      keptAsTyped: (title: string, location: string) =>
        `📍 Адрес для «${title}» оставил как написано: ${location}. Можешь отправить 📍 геолокацию или написать полный адрес.`,
      locationChoiceOutdated:
        '📍 Этот выбор уже неактуален. Чтобы задать место, отправь 📍 геолокацию или напиши полный адрес.',
      locationNotFound: (title: string) =>
        `📍 Не удалось определить адрес для «${title}». Можешь отправить 📍 геолокацию или написать полный адрес.`,
      geoForEvent: (title: string) => `📍 Получена геолокация! Это для события «${title}»?`,
      geoForEventConfirm: 'Да, использовать для этого события',
      geoNewLocation: 'Нет, это моё текущее местоположение',
      geoExplain: 'Другое',
      geoOtherAck: '📍 Понял. Пин сохранён на 30 минут — просто скажи, к какому событию его привязать, и я сделаю это.',
      geoPurposeQuestion:
        '📍 Получена геолокация! Для чего она?\n1. Обновить город\n2. Задать локацию для последнего события\n3. Другое (напиши пояснение)',
    },
  },
} as const;

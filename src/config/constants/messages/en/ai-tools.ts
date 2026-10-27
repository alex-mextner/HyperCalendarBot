// src/config/constants/messages/en/ai-tools.ts
// AI tool-result wording (calendar reads/writes, participants, notifications).

export const enAiTools = {
  aiTools: {
    memory: {
      saved: 'Saved.',
      storageUnavailable: 'I cannot save anything right now — memory storage is unavailable.',
      empty: 'There was nothing to remember in that.',
      tooLong: (length: number, limit: number) =>
        `That fact is too long to keep — length ${length}, limit ${limit}. Say the essence in one short sentence, or split it into several facts.`,
    },
    history: {
      notFound: 'No history found.',
    },
    actionLog: {
      notFound: 'No action log entries found.',
    },
    meta: {
      noHolidays: 'No upcoming holidays. You may not have country subscriptions set up.',
      holidaysList: (lines: string) => `Upcoming holidays:\n${lines}`,
      foundUser: (id: number, name: string) => `Found user: telegram_id=${id}, name=${name}`,
      addressBookEmpty: 'Address book is empty.',
      invitationLinkUnavailable:
        'This invitation is not available to your Telegram account. Ask the sender to check the recipient.',
      recipientMissing: 'Choose a recipient (invitee_id or invitee_username).',
      recipientNotFound: (username: string) =>
        `@${username} not found on Telegram. Check the username or use the Telegram picker.`,
      recipientResolveUnavailable:
        'Username resolution is unavailable. Choose a saved contact or use the Telegram picker.',
      recipientLookupFailed: (username: string) =>
        `Could not verify @${username}. Choose a saved contact or use the Telegram picker.`,
      contactDeleteRequiresTool:
        'Renaming contact fields does not delete the contact. Use the contact deletion operation.',
      contactDeleted: 'Contact removed from your address book. Events and invitations were not changed.',
      contactAlreadyAbsent: 'That contact is not in your address book. Nothing else was changed.',
      contactsPrivateOnly: 'Open our private chat to remove an address-book contact.',
      recipientNameAmbiguous:
        'That looks like a saved contact name, not the requested Telegram username. Select the person from your contacts.',
      recipientUsernameUnconfirmed:
        'I cannot infer a Telegram username from a name. Choose a saved contact or provide the exact @username.',
      userInfo: (details: string) => `User details:\n${details}`,
      recipientConfirmButton: 'Confirm this ID',
      recipientSavedProfile: (name: string, id: number) => `Saved contact: ${name} (ID ${id}).`,
      recipientResolvedProfile: (name: string, id: number) => `Username resolves to: ${name} (ID ${id}).`,
      recipientConfirmationSent: 'Recipient confirmation sent to your private chat.',
      recipientConfirmDetails: (id: number, username: string) =>
        `Recipient needs confirmation. Requested Telegram ID: ${id}; username hint: ${username}. These details may identify different accounts. Confirm only if this numeric ID is the person you intended. Otherwise use the Telegram user picker.`,
      recipientIdentityConflict:
        'The recipient ID and username identify different people. Choose the intended person again; no invitation was created.',
      recipientUnverified:
        'I cannot verify this recipient. Choose the person from your contacts or the Telegram picker; no invitation was created.',
      recipientContactRowId: 'A contact number from the address book is not a Telegram ID; no invitation was created.',
      recipientContactWithoutTelegram: (name: string) =>
        `"${name}" in your contacts has no linked Telegram account. Choose them with the Telegram user picker; no invitation was created.`,
      contactsList: (lines: string) => `Contacts:\n${lines}`,
      contactSaved: (name: string) => `Contact saved: ${name}`,
      contactFound: (data: string) => `Contact found: ${data}`,
      contactMatches: (lines: string) => `Contact matches:\n${lines}`,
      contactUpdated: (label: string) => `Contact updated: ${label}`,
      questionSent: 'Question sent. Waiting for user response.',
      deleteConfirmHeader: (count: number) => (count === 1 ? 'Delete this event?' : `Delete these ${count} events?`),
      deleteConfirmPastNote: (count: number) =>
        `⚠️ ${count} of them already ended. They are deleted only with “Including past”.`,
      deletePastMark: 'already ended',
      deleteRecurringMark: 'recurring series',
      deleteButton: (count: number) => `🗑 Delete (${count})`,
      deleteUpcomingOnlyButton: (count: number) => `🗑 Upcoming only (${count})`,
      deleteIncludingPastButton: (count: number) => `Including past (${count})`,
      deletePastButton: (count: number) => `🗑 Delete past (${count})`,
      deleteCancelButton: 'Cancel',
      deleteConfirmationSent: 'Delete confirmation sent. Waiting for the user to tap.',
      deleteConfirmationSentToChat: 'I sent the list to our chat. Tap a button there to delete.',
      deleteNeedsConfirmation: 'Not deleted: the user has not confirmed this event in the bot’s delete list.',
      deleteTargetsNotFound: (ids: string) => `Not found or not yours to delete: ${ids}. Nothing was sent.`,
      deleteConfirmExpired: 'This confirmation is no longer valid. Ask me to delete again.',
      deleteDone: (count: number) => `✅ Deleted: ${count}`,
      deleteKeptPast: (count: number) => `Past events kept: ${count}`,
      deleteFailed: (titles: string) => `⚠️ Not deleted: ${titles}`,
      deleteCancelled: '❌ Cancelled, nothing was deleted.',
      dayImageSent: (date: string) => `Day calendar image for ${date} has been sent to the chat.`,
      weekImageSent: (week: string) => `Calendar for ${week} — the picture is in the chat.`,
      monthImageSent: (month: string) => `Monthly calendar image for ${month} has been sent to the chat.`,
      dayImageFailed: (date: string) => `Failed to render or send the day image for ${date}.`,
      dayImageSentInstead: (date: string, requested: string) =>
        `Day calendar image for ${date} has been sent to the chat instead of the past day ${requested}: ${date} is the nearest upcoming day with the changes just made.`,
      weekImageFailed: (weekStart: string) => `Failed to render or send the weekly image starting ${weekStart}.`,
      monthImageFailed: (month: string) => `Failed to render or send the monthly image for ${month}.`,
      callQueued: 'Call queued. You will receive a voice call shortly.',
      callQueueFailed: "Couldn't schedule the call: the call queue is unavailable. No call will be made.",
      callFailed: (text: string) => `📞 Couldn't reach you by call.\n\n${text}`,
      gcalNotConnected: 'Google Calendar is not connected. You can connect it with /connect_google command.',
      gcalConnectedNoData: 'Google Calendar is connected, but calendar data is not available.',
      gcalConnectedHeader: 'Google Calendar is connected.',
      gcalCalendarsCount: (total: number, syncing: number) => `Calendars: ${total} total, ${syncing} syncing.`,
      gcalNoCalendars: 'No Google Calendars found. Sync may still be in progress.',
      gcalList: (lines: string) => `Google Calendars:\n${lines}`,
      userPickerSent: 'User picker sent. Waiting for user to select participants.',
      sceneResumed: 'Continue the wizard from where you left off.',
      sceneCancelled: 'Wizard cancelled.',
      tableSent: (title: string) => `Table "${title}" has been sent to the chat.`,
      tableFailed: (title: string) => `Failed to render or send the table "${title}".`,
      tableRenderingVoice: 'Check the chat — the table is there.',
      telegramConnectedStatus: 'Telegram account connected',
      telegramNotConnectedStatus: 'Telegram account not connected. Connect via /connect_telegram',
    },
    slots: {
      noFreeSlots: 'No free slots — the entire day is busy.',
      invalidDate: 'Invalid date. Use a real calendar date like 2026-03-15.',
      freeSlots: (lines: string) => `Free slots:\n${lines}`,
    },
    settings: {
      callsUpdated: 'Call settings updated.',
      notificationsUpdated: (keys: string) => `Notification settings updated: ${keys}`,
      privacyUpdated: (lines: string) => `Privacy settings updated: ${lines}`,
      voiceUpdated: (value: string) => `Voice settings updated: voice_response_enabled = ${value}`,
    },
    feedback: {
      feedbackSent: 'Feedback sent to developer. They will respond in this chat.',
    },
    events: {
      emptyAgenda: {
        calendar: {
          personal: 'in your calendar',
          group: "in this group's calendar",
          delegated: 'in the selected calendar',
        },
        relativeDay: {
          yesterday: 'yesterday',
          today: 'today',
          tomorrow: 'tomorrow',
          dayAfterTomorrow: 'the day after tomorrow',
        },
        dateTime: (date: string, time: string) => `${date}, ${time}`,
        dayUpcoming: (relative: string | null, date: string, calendar: string) =>
          `No events ${calendar} start ${relative ? `${relative}, ${date}` : `on ${date}`}.`,
        dayPast: (relative: string | null, date: string, calendar: string) =>
          `No events ${calendar} started ${relative ? `${relative}, ${date}` : `on ${date}`}.`,
        window: (relative: string | null, date: string, from: string, to: string, calendar: string) =>
          `No events ${calendar} start ${relative ? `${relative}, ${date},` : `on ${date}`} between ${from} and ${to}.`,
        windowSpan: (from: string, to: string, calendar: string) =>
          `No events ${calendar} start between ${from} and ${to}.`,
        windowPast: (relative: string | null, date: string, from: string, to: string, calendar: string) =>
          `No events ${calendar} started ${relative ? `${relative}, ${date},` : `on ${date}`} between ${from} and ${to}.`,
        windowSpanPast: (from: string, to: string, calendar: string) =>
          `No events ${calendar} started between ${from} and ${to}.`,
        rangeUpcoming: (from: string, to: string, calendar: string) =>
          `No events ${calendar} start between ${from} and ${to}.`,
        rangePast: (from: string, to: string, calendar: string) =>
          `No events ${calendar} started between ${from} and ${to}.`,
        rangeCurrent: (from: string, to: string, calendar: string) =>
          `No events ${calendar} start between ${from} and ${to}.`,
      },
      noEventsMatching: 'No events found matching the query.',
      noEventsMatchingScope: (scope: string) =>
        `No events found matching the query in ${scope} calendar. Try searching the other scope.`,
      noUpcomingEvents: 'No upcoming events.',
      upcomingEvents: (count: number, lines: string) => `Next ${count} events:\n${lines}`,
      eventCreated: (parts: string) => `Event created: ${parts}`,
      eventUpdated: (parts: string) => `Event updated: ${parts}`,
      eventDeleted: (title: string, id: number) => `Event "${title}" (id: ${id}) deleted.`,
      eventDeclined: (id: number) =>
        `You declined the shared event (id: ${id}). It has been removed from your calendar.`,
      snoozed: (title: string, minutes: number, newStart: string) =>
        `Event "${title}" snoozed by ${minutes} min. New start: ${newStart}`,
      notificationQueued: (count: number) => `Notification queued for ${count} participant${count !== 1 ? 's' : ''}.`,
      participantUpdate: (eventTitle: string, senderName: string, message: string) =>
        `📅 Update on "${eventTitle}" from ${senderName}:\n${message}`,
      participantHint: (count: number) =>
        `. This event has ${count} participant${count > 1 ? 's' : ''} — notify them if the change is significant (use notify_participants tool).`,
      locationAttached: (eventId: number) => `📍 Location attached to event #${eventId}.`,
    },
    reminders: {
      noReminders: (title: string) => `No reminders set for "${title}".`,
      remindersSet: (title: string, descriptions: string) => `Reminders set for "${title}": ${descriptions}`,
      remindersDisabled: (title: string) => `All reminders disabled for "${title}".`,
      remindersFor: (title: string, lines: string) => `Reminders for "${title}": ${lines}`,
      durationMin: (n: number) => `${n}min`,
      durationHourMin: (h: number, m: number) => (m > 0 ? `${h}h ${m}m` : `${h}h`),
      beforeDuration: (dur: string) => `${dur} before`,
      noEventsForQuery: (query: string) => `No events found for "${query}".`,
      noRemindersLabel: 'No reminders',
      noRemindersFound: 'No reminders found.',
    },
    sharing: {
      eventShared: (title: string, id: number, targetType: string, targetId: number) =>
        `Event "${title}" shared (id: ${id}, target: ${targetType} ${targetId}).`,
      invitationCreated: (invId: number, eventId: number, inviteeId: number) =>
        `Invitation created (id: ${invId}, event: ${eventId}, invitee: ${inviteeId}). Notification is being sent in background.`,
      invitationCancelled: (id: number) => `Invitation ${id} cancelled.`,
      invitationReminderQueued: (userId: number) =>
        `Invitation reminder queued for user ${userId}. Notification is being sent in background.`,
      noInvitations: (title: string) => `No invitations for event "${title}".`,
      invitationsFor: (title: string, id: number, lines: string) => `Invitations for "${title}" (id: ${id}):\n${lines}`,
      rsvpSelf: 'you',
      rsvpStatuses: {
        pending: 'pending',
        accepted: 'accepted',
        declined: 'declined',
        maybe: 'maybe',
        cancelled: 'cancelled',
        expired: 'expired',
      },
      rsvpAttending: (count: number) => `attending (going): ${count}`,
      rsvpOrganizer: (userId: number | string) => `organizer: ${userId}`,
      rsvpInviteeLine: (userId: number | string, status: string, note: string) =>
        `invitee: ${userId}, status: ${status}${note}`,
      rsvpMemberLine: (userId: number | string, status: string) => `  member: ${userId}, status: ${status}`,
      rsvpPersonalInviteNote: (inviteStatus: string) => ` (personal invite: ${inviteStatus})`,
      groupRsvpHeader: 'group invitation — per-member RSVP:',
      groupRsvpNone: 'group invitation: no member RSVPs yet',
      groupRsvpUnavailable: 'group invitation: members RSVP per-member (participant registry unavailable)',
      noEventsToShare: (period: string) => `No visible events to share for ${period}.`,
      agendaShared: (period: string, targetType: string, targetId: number, count: number, lines: string) =>
        `Agenda for ${period} shared with ${targetType} ${targetId} (${count} events):\n${lines}`,
      visibilitySet: (title: string, id: number, visibility: string) =>
        `Visibility for "${title}" (id: ${id}) set to "${visibility}".`,
      editProposalSubmitted: (id: number) =>
        `Edit proposal submitted (id: ${id}). The event creator will be notified to accept or reject.`,
      deliveryFallbackWithLink: (eventTitle: string, invitee: string, url: string) =>
        `⚠️ Could not deliver invitation to ${invitee} for "${eventTitle}" directly. Forward this link to the invitee: ${url}`,
      deliveryFallbackNoLink: (eventTitle: string, invitee: string) =>
        `⚠️ Could not deliver invitation to ${invitee} for "${eventTitle}" directly.`,
      userSessionInvitation: (args: {
        title: string;
        dateLine: string;
        locationLine: string;
        descriptionLine: string;
        deepLink: string;
      }) =>
        `Inviting you to "${args.title}"\n📅 ${args.dateLine}${args.locationLine}${args.descriptionLine}\n\nDetails & RSVP: ${args.deepLink}`,
    },
    birthdays: {
      created: (name: string, day: number, month: number) =>
        `Birthday created: Bday ${name} (${day}.${String(month).padStart(2, '0')})`,
      alreadyExists: (name: string, day: number, month: number) =>
        `Birthday for ${name} already exists: ${day}.${String(month).padStart(2, '0')}`,
      conflictError: (name: string, day: number, month: number) =>
        `Birthday for ${name} already exists on ${day}.${String(month).padStart(2, '0')}. To update, call again with the correct date.`,
    },
    scheduled: {
      noScheduledCalls: 'No scheduled calls.',
      noTriggers: 'No triggers.',
      scheduleCreated: (id: string, message: string, when: string) => `Scheduled (id: ${id}): "${message}" at ${when}`,
      scheduleCancelled: (id: string) => `Schedule ${id} cancelled.`,
      triggerCreated: (id: string, topic: string, condition: string | null, action: string) =>
        `Trigger created (id: ${id}): when ${topic}${condition ? ` and (${condition})` : ''} → "${action}"`,
      triggerRemoved: (id: string) => `Trigger ${id} removed.`,
    },
    location: {
      clarifyAddress: (title: string) => `📍 Clarify the address for "${title}":`,
      locationResolved: (title: string, address: string) => `📍 Location for "${title}" resolved: ${address}`,
      noneOfThese: '🚫 None of these — keep as typed',
      keptAsTyped: (title: string, location: string) =>
        `📍 Location for "${title}" kept as typed: ${location}. You can send a 📍 location pin or type the full address.`,
      locationChoiceOutdated:
        '📍 This choice is out of date. To set the place, send a 📍 location pin or type the full address.',
      locationNotFound: (title: string) =>
        `📍 Could not resolve location for "${title}". You can send a 📍 location pin or type the full address.`,
      geoForEvent: (title: string) => `📍 Got your location! Is this for the event "${title}"?`,
      geoForEventConfirm: 'Yes, use for this event',
      geoNewLocation: 'No, this is my current location',
      geoExplain: 'Something else',
      geoOtherAck: "📍 Got it. The pin is saved for 30 minutes — just tell me which event it's for and I'll attach it.",
      geoPurposeQuestion:
        '📍 Got your location! What is it for?\n1. Update your current city\n2. Set as location for your latest event\n3. Something else (please explain)',
    },
  },
} as const;

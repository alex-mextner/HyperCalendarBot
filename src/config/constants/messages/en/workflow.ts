// src/config/constants/messages/en/workflow.ts
// Intent-workflow outcome text, day headings and write-receipt wording.

import { capitalize } from '../../text-helpers.ts';

export const enWorkflow = {
  intentWorkflow: {
    failedUnchanged: 'I could not complete that, and nothing was changed. Please try again or rephrase.',
    appliedIncomplete:
      'The change went through, but I could not finish the rest of the request. Check your calendar; I will not repeat it.',
    outcomeUnknown:
      'I could not confirm whether that went through. Check your calendar before repeating the request; I will not retry it automatically.',
    /** Monday first, for a day heading such as "Today, Mon 09/14". */
    weekdaysShort: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    dayHeading: (relative: string | null, weekday: string, day: string, month: string) =>
      `${relative ? `${capitalize(relative)}, ` : ''}${weekday} ${month}/${day}`,
  },
  writeOutcomes: {
    // What the model reads back from send_invitation: one invitation, said once.
    invitationDelivered: 'Invitation delivered',
    invitationManual: 'Invitation created; not delivered. Please forward the link sent to your private chat.',
    invitationFailed: 'Invitation created; not delivered.',
    interrupted: 'The request was interrupted. Some actions may already have happened; no automatic replay will run.',
    receipt: {
      intro: 'Done in your calendar:',
      created: (title: string, when: string) => `Created: "${title}" — ${when}`,
      alreadyThere: (title: string, when: string) => `Already in the calendar: "${title}" — ${when}`,
      updated: (title: string, when: string) => `Updated: "${title}" — now ${when}`,
      deleted: (title: string, when: string) => `Deleted: "${title}" (was ${when})`,
      allDay: 'all day',
      outro: 'This comes from the calendar itself. I could not verify my written answer, so I am not sending it.',
    },
    spokenQuestion: (question: string, options: string) => `${question} Options: ${options}`,
    // The receipt that replaces the model's text when a run had failed, skipped or unconfirmed writes.
    anEvent: 'event',
    theEvent: 'the event',
    eventNamed: (title: string, when: string | null) => (when ? `event “${title}” (${when})` : `event “${title}”`),
    eventTitle: (title: string) => `“${title}”`,
    change: 'change',
    calendarOf: (name: string) => `calendar: ${name}`,
    otherCalendar: 'another calendar',
    delegatedCalendar: 'someone else’s calendar that you manage as a secretary',
    changedFields: (fields: readonly string[]) => `, fields: ${fields.join(', ')}`,
    nothingChanged: 'nothing was changed',
    skipped: 'skipped, not run again',
    repeatUnknown: (event: string | null) =>
      event
        ? `A repeat of the creation could not be confirmed: ${event}. Check the calendar for a duplicate.`
        : 'A repeat of an event creation could not be confirmed. Check the calendar for a duplicate.',
    retriedAfterUnknown:
      'The retry worked, but the first try may have gone through too: check the calendar for a duplicate.',
    attendanceDeclined: (title: string | null) =>
      title ? `Attendance of “${title}” declined; the event remains.` : 'Attendance declined; the event remains.',
    retry: 'Tell me what to repeat: I will not redo what already went through.',
    checkFirst: 'Check the calendar before repeating anything; I never repeat a request on my own.',
    people: (names: readonly string[], unnamed: number) => {
      const count = `${unnamed} ${unnamed === 1 ? 'person' : 'people'}`;
      if (names.length === 0) return count;
      return unnamed === 0 ? names.join(', ') : `${names.join(', ')} and ${unnamed} more`;
    },
    invitations: {
      sent: (n: number, event: string, who: string) =>
        n === 1 ? `The invitation to ${event} was sent: ${who}.` : `The invitations to ${event} were sent: ${who}.`,
      created: (n: number, event: string, who: string) =>
        n === 1
          ? `The invitation to ${event} was created: ${who}.`
          : `The invitations to ${event} were created: ${who}.`,
      manual: (n: number, event: string, who: string) =>
        n === 1
          ? `The invitation to ${event} was created but not delivered: ${who}. Please forward the link sent to your private chat.`
          : `The invitations to ${event} were created but not delivered: ${who}. Please forward the links sent to your private chat.`,
      undelivered: (n: number, event: string, who: string) =>
        n === 1
          ? `The invitation to ${event} was created but not delivered: ${who}.`
          : `The invitations to ${event} were created but not delivered: ${who}.`,
      rejected: (n: number, event: string, who: string) =>
        n === 1
          ? `The invitation to ${event} was not sent: ${who}.`
          : `The invitations to ${event} were not sent: ${who}.`,
      unknown: (n: number, event: string, who: string) =>
        n === 1
          ? `Could not confirm that the invitation to ${event} went through: ${who}.`
          : `Could not confirm that the invitations to ${event} went through: ${who}.`,
      skipped: (n: number, event: string, who: string) =>
        n === 1
          ? `The invitation to ${event} was skipped and not sent again: ${who}.`
          : `The invitations to ${event} were skipped and not sent again: ${who}.`,
    },
    // A create that found its event already saved (same event, nothing written by this run).
    alreadyThere: 'Already in the calendar',
    operations: {
      create_event: {
        done: 'Created',
        notDone: 'Not created',
        unknown: 'Could not confirm creation',
      },
      update_event: {
        done: 'Updated',
        notDone: 'Not updated',
        unknown: 'Could not confirm the update',
      },
      delete_event: {
        done: 'Deleted',
        notDone: 'Not deleted',
        unknown: 'Could not confirm the deletion',
      },
    },
    otherWrite: {
      done: 'Done',
      notDone: 'Not done',
      unknown: 'Could not confirm it went through',
    },
    field: 'field',
    fields: {
      title: 'title',
      start_at: 'start time',
      end_at: 'end time',
      description: 'description',
      location: 'location',
      all_day: 'all day',
      timezone: 'timezone',
      category: 'category',
      location_abstract: 'location type',
      recurrence_rule: 'recurrence',
      recurrence_end_at: 'recurrence end',
      reminder_overrides: 'reminders',
    },
  },
} as const;

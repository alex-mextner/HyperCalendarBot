// src/config/constants/messages/en/workflow.ts
// Intent-workflow outcome text, day headings and write-outcome (delivery/attempt) wording.

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
    completed: 'Completed',
    notCompleted: 'Not completed',
    uncertain: 'Outcome unknown',
    failed: 'attempt failed; completion not confirmed',
    notApplied: 'request rejected before applying changes',
    skipped: 'skipped; no new write executed',
    invitationDelivered: 'Invitation delivered',
    invitationManual: 'Invitation created; not delivered. Please forward the link sent to your private chat.',
    invitationFailed: 'Invitation created; not delivered.',
    attendanceDeclined: 'Attendance declined; the event remains.',
    interrupted: 'The request was interrupted. Some actions may already have happened; no automatic replay will run.',
    attempts:
      'These are distinct execution attempts, not a list of outstanding requests. Later successes are shown separately.',
    write: 'Write',
    field: 'field',
    attempt: (n: number) => `Attempt ${n}`,
    spokenQuestion: (question: string, options: string) => `${question} Options: ${options}`,
    operations: {
      delete_event: 'Delete event',
      update_event: 'Update event',
      create_event: 'Create event',
      send_invitation: 'Send invitation',
    },
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

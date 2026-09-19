export type LegacyDisposition = 'merge' | 'rewrite' | 'retire';

export interface LegacyDispositionEntry {
  oldKey: string;
  disposition: LegacyDisposition;
  /** Canonical successor for merge and rewrite; null for retire, which has no automatic replacement. */
  target: string | null;
  reason: string;
}

const merge = (oldKey: string, target: string, reason: string): LegacyDispositionEntry => ({
  oldKey,
  disposition: 'merge',
  target,
  reason,
});
const rewrite = (oldKey: string, target: string, reason: string): LegacyDispositionEntry => ({
  oldKey,
  disposition: 'rewrite',
  target,
  reason,
});
const retire = (oldKey: string, reason: string): LegacyDispositionEntry => ({
  oldKey,
  disposition: 'retire',
  target: null,
  reason,
});

const SAME_FAMILY = 'Same request, now one parameterized rule with typed day/period parsing.';
const NO_LAST_MENTIONED =
  'Resolved its target from the last mentioned event, which can select the wrong event; a title or number is now required.';
const NO_FAKE_REMINDER =
  'There is no free-standing reminder tool; the old recipe faked one with an extra event. Left to the assistant to clarify.';
const NO_SHARING =
  'Sharing an agenda widens who can read it and needs a verified recipient; a read-looking phrase must not do that.';

/**
 * Every recovered key (98 archived source names plus the 6 previously seeded; see docs/intents/legacy-source-manifest.json)
 * maps to exactly one canonical successor or to a stated retirement.
 */
export const legacyDisposition: LegacyDispositionEntry[] = [
  // ─── previously seeded ────────────────────────────────────────────────────
  merge('show_today', 'basis.calendar.day', SAME_FAMILY),
  merge('show_tomorrow', 'basis.calendar.day', SAME_FAMILY),
  merge('show_week', 'basis.calendar.period', SAME_FAMILY),
  merge('free_slots_today', 'basis.slots.day', SAME_FAMILY),
  merge(
    'search_events_by_query',
    'basis.calendar.search',
    'Same search; a connector word is now required so a date is not searched as a title.',
  ),
  rewrite(
    'create_event_named_tomorrow',
    'basis.event.create',
    'Used the current UTC offset (wrong across clock changes) and only tomorrow at a bare hour; now any day, an IANA-zone instant, and an explicit confirmation with conflicts.',
  ),

  // ─── contacts ─────────────────────────────────────────────────────────────
  merge('list_contacts', 'basis.contacts.list', 'Same request; refuses in a group before reading and never forces.'),
  merge('find_contact_by_name', 'basis.contacts.find', 'Same request; private chat only.'),
  retire(
    'who_is_contact',
    'Matched any "who is X" question, including general knowledge; only an explicit "find contact" is safe.',
  ),
  merge('add_contact_to_book', 'basis.contacts.add', 'Same request with an optional verified @username.'),
  rewrite(
    'rename_contact',
    'basis.contacts.rename',
    'Now needs a unique contact, a quoted or single-word name, and confirmation.',
  ),

  // ─── deleting and editing events ──────────────────────────────────────────
  rewrite(
    'delete_event_by_name',
    'basis.event.delete',
    'Now requires exactly one title match or a number, and confirmation.',
  ),
  retire(
    'delete_next_event',
    'Chose "the next event" implicitly; a wrong pick deletes the wrong event. Use a title or number.',
  ),
  retire('clear_today_events', 'Bulk deletion; no rule may delete more than one event per confirmed request.'),
  retire('cancel_event_by_time_today', 'A time can match several events; selection by clock time is ambiguous.'),
  retire('cancel_event_by_time_tomorrow', 'A time can match several events; selection by clock time is ambiguous.'),
  retire('delete_last_created_event', NO_LAST_MENTIONED),
  retire('cancel_referenced_event', NO_LAST_MENTIONED),
  retire(
    'decline_event_invitation',
    'The delete tool turns deletion of a non-owned event into declining attendance, so the recipe misnamed one action as the other.',
  ),
  rewrite('rename_event', 'basis.event.rename', 'Now needs a quoted title or number, and confirmation.'),
  rewrite('change_event_location', 'basis.event.set_detail', 'Now names the event explicitly and asks first.'),
  rewrite('add_event_description', 'basis.event.set_detail', 'Now names the event explicitly and asks first.'),
  rewrite(
    'add_participant_to_event',
    'basis.invite.send',
    'Adding a participant is an invitation; it now needs an exact @username or numeric ID, a chosen event and confirmation, and the tool verifies the recipient.',
  ),
  retire('remove_own_participation', 'Same misnamed decline-as-delete action as decline_event_invitation.'),
  retire(
    'extend_event_duration_minutes',
    'Needs read-modify-write arithmetic on the end time; no tool changes duration relatively.',
  ),
  retire(
    'extend_event_duration_hours',
    'Needs read-modify-write arithmetic on the end time; no tool changes duration relatively.',
  ),
  retire(
    'shorten_event_duration_minutes',
    'Needs read-modify-write arithmetic on the end time; no tool changes duration relatively.',
  ),

  // ─── reading the calendar ─────────────────────────────────────────────────
  merge('get_upcoming_next', 'basis.calendar.upcoming', 'Same request with an optional count.'),
  merge(
    'show_specific_date',
    'basis.calendar.day',
    'Same request; absolute dates are parsed and impossible ones rejected.',
  ),
  merge('show_day_after_tomorrow', 'basis.calendar.day', SAME_FAMILY),
  merge('show_this_month', 'basis.calendar.period', SAME_FAMILY),
  merge('show_next_month', 'basis.calendar.period', SAME_FAMILY),
  merge('show_weekend', 'basis.calendar.period', SAME_FAMILY),
  retire(
    'events_with_person',
    'Event search matches titles, not participants, and declined names ("Ивана" vs "Иван") never match.',
  ),
  merge('count_events_today', 'basis.calendar.count', SAME_FAMILY),
  merge('count_events_week', 'basis.calendar.count', SAME_FAMILY),
  merge('count_events_month', 'basis.calendar.count', SAME_FAMILY),

  // ─── free time ────────────────────────────────────────────────────────────
  merge('free_slots_tomorrow', 'basis.slots.day', SAME_FAMILY),
  rewrite(
    'free_slots_week',
    'basis.slots.week',
    'Rendered a calendar image instead of calculating availability; now queries every day of the week.',
  ),
  rewrite(
    'free_slots_next_week',
    'basis.slots.week',
    'Queried only Monday and Sunday; now all seven days of the week.',
  ),
  merge('free_slots_on_date', 'basis.slots.day', 'Same request; absolute dates parsed and validated.'),
  rewrite(
    'am_i_free_today_at_time',
    'basis.slots.check_time',
    'Now checks the real window with an explicit zone-aware instant and refuses ambiguous bare hours.',
  ),
  rewrite(
    'am_i_free_tomorrow_at_time',
    'basis.slots.check_time',
    'Now checks the real window with an explicit zone-aware instant and refuses ambiguous bare hours.',
  ),
  retire('common_free_time_with_contact', "Needs another person's calendar, which no tool exposes."),
  retire('busiest_day_this_week', 'Needs aggregation over events that no tool provides; left to the assistant.'),

  // ─── Google Calendar ──────────────────────────────────────────────────────
  merge('google_calendar_connection_status', 'basis.google.status', 'Same request; private chat only.'),
  merge('google_calendar_list', 'basis.google.calendars', 'Same request; private chat only.'),
  merge(
    'google_calendar_connect_howto',
    'basis.google.connect_help',
    'Same explicit connection instructions, without pretending to change Google authorization.',
  ),
  rewrite(
    'google_calendar_disconnect',
    'basis.google.connect_help',
    'Pretended to disconnect from a chat phrase; now answers with the real /disconnect_google command only.',
  ),
  merge(
    'google_calendar_sync_status',
    'basis.google.status',
    'Same verified connection status from the actual Google status tool.',
  ),
  merge(
    'google_calendar_reconnect',
    'basis.google.connect_help',
    'Same explicit connection instructions, without pretending to change Google authorization.',
  ),

  // ─── holidays and bot information ─────────────────────────────────────────
  merge(
    'show_upcoming_holidays',
    'basis.holidays.upcoming',
    'Same read-only intent, consolidated with parameterized variants in the new basis.',
  ),
  merge('show_next_public_holiday', 'basis.holidays.upcoming', 'Same request with a limit of one.'),
  retire(
    'is_today_public_holiday',
    'The holiday tool has no date filter, so the recipe could only return an unfiltered list under a misleading label.',
  ),
  retire(
    'show_holidays_this_month',
    'The holiday tool has no date filter, so the recipe could only return an unfiltered list under a misleading label.',
  ),
  retire(
    'show_holidays_this_year',
    'The holiday tool has no date filter, so the recipe could only return an unfiltered list under a misleading label.',
  ),
  merge('bot_capabilities_overview', 'basis.bot.info', 'Same answer from the bot information tool.'),
  retire('bot_help_commands', 'The bot information tool holds no command list.'),
  merge('bot_hidden_features', 'basis.bot.info', 'Same answer from the bot information tool.'),
  merge('bot_developer_contact', 'basis.bot.info', 'The bot information tool includes the developer contact.'),
  retire('bot_supported_languages', 'The bot information tool does not list languages.'),

  // ─── reminders ────────────────────────────────────────────────────────────
  rewrite('reminders_for_event', 'basis.reminder.list', 'Now resolves exactly one event first.'),
  rewrite(
    'remind_minutes_before_event',
    'basis.reminder.set',
    'Now one rule for minutes and hours, resolving one event and asking before replacing its reminders.',
  ),
  rewrite(
    'remind_hours_before_event',
    'basis.reminder.set',
    'Now one rule for minutes and hours, resolving one event and asking before replacing its reminders.',
  ),
  rewrite(
    'remind_relative_minutes',
    'basis.reminder.after',
    'One explicit confirmed reminder entry with a bounded relative duration and notification at start.',
  ),
  rewrite(
    'remind_relative_hours',
    'basis.reminder.after',
    'Hours and minutes share a typed duration and a single confirmed reminder event.',
  ),
  retire('remind_at_time_today', NO_FAKE_REMINDER),
  retire('remind_recurring_daily', NO_FAKE_REMINDER),
  rewrite(
    'cancel_reminder',
    'basis.reminder.clear',
    'Now resolves exactly one event and asks before clearing its reminders.',
  ),

  // ─── shifting events ──────────────────────────────────────────────────────
  rewrite('snooze_event_minutes', 'basis.event.snooze', 'Units are now one rule; the event is named and confirmed.'),
  rewrite('snooze_event_hours', 'basis.event.snooze', 'Units are now one rule; the event is named and confirmed.'),
  retire('snooze_event_default', NO_LAST_MENTIONED),
  retire(
    'move_event_earlier_minutes',
    'The snooze tool only moves later and does not check the past; an explicit new time is the safe way.',
  ),
  retire(
    'move_event_earlier_hours',
    'The snooze tool only moves later and does not check the past; an explicit new time is the safe way.',
  ),
  retire('move_event_earlier_default', NO_LAST_MENTIONED),
  retire(
    'move_event_to_tomorrow',
    'Keeping the old time of day needs read-modify-write arithmetic; give the new day and time instead.',
  ),
  retire(
    'move_event_to_next_week',
    'Keeping the old day and time needs read-modify-write arithmetic; give the new day and time instead.',
  ),
  rewrite(
    'reschedule_event_to_tomorrow_at_time',
    'basis.event.reschedule',
    'Any explicit day and time, an explicitly named event, and a zone-aware instant.',
  ),

  // ─── settings ─────────────────────────────────────────────────────────────
  merge('view_settings_summary', 'basis.settings.view', 'Same request with an optional category.'),
  merge('enable_morning_agenda', 'basis.settings.toggle', 'One toggle rule for the four supported switches.'),
  merge('disable_morning_agenda', 'basis.settings.toggle', 'One toggle rule for the four supported switches.'),
  merge('enable_evening_review', 'basis.settings.toggle', 'One toggle rule for the four supported switches.'),
  merge('disable_evening_review', 'basis.settings.toggle', 'One toggle rule for the four supported switches.'),
  rewrite(
    'set_quiet_hours_night',
    'basis.settings.toggle',
    'Sets the quiet-hours switch only; it never invented night hours.',
  ),
  merge('disable_quiet_hours', 'basis.settings.toggle', 'One toggle rule for the four supported switches.'),
  merge(
    'set_default_duration_15',
    'basis.settings.duration',
    'Any duration in minutes or hours instead of one rule per value.',
  ),
  merge(
    'set_default_duration_30',
    'basis.settings.duration',
    'Any duration in minutes or hours instead of one rule per value.',
  ),
  merge('enable_voice_responses', 'basis.settings.toggle', 'One toggle rule for the four supported switches.'),
  merge('disable_voice_responses', 'basis.settings.toggle', 'One toggle rule for the four supported switches.'),
  retire(
    'reset_settings_to_default',
    'Bulk destructive reset with no tool for it; a chat phrase must not erase all preferences.',
  ),

  // ─── sharing, visibility and access ───────────────────────────────────────
  retire('share_agenda_today', NO_SHARING),
  retire('share_agenda_tomorrow', NO_SHARING),
  retire('share_agenda_week', NO_SHARING),
  retire('share_last_event', `${NO_SHARING} It also used the last mentioned event.`),
  rewrite(
    'invite_secretary_read',
    'basis.secretary.invite',
    'Granting access by @username is unverifiable; now a numeric ID, an explicit permission and confirmation, with a clarifying reply for @username.',
  ),
  rewrite(
    'invite_secretary_write',
    'basis.secretary.invite',
    'Granting access by @username is unverifiable; now a numeric ID, an explicit permission and confirmation, with a clarifying reply for @username.',
  ),
  rewrite(
    'hide_event_from_sharing',
    'basis.event.hide',
    'Narrowing only, for an explicitly named event, after confirmation.',
  ),
  retire(
    'show_event_full_details',
    'Widens visibility from a phrase that reads like a read request, and targeted the last mentioned event.',
  ),

  // ─── time zones ───────────────────────────────────────────────────────────
  merge(
    'current_time_in_city',
    'basis.time.now',
    'Same read-only intent, consolidated with parameterized variants in the new basis.',
  ),
  rewrite(
    'convert_my_time_to_city',
    'basis.time.convert',
    'Now an IANA zone and a zone-aware instant for today; a skipped or repeated local time is rejected.',
  ),
  retire(
    'current_timezone_setting',
    'Answerable from the profile by the assistant; the settings view already lists it.',
  ),
  retire('world_clock_common_cities', 'Depended on a fixed city list that goes stale.'),
  retire('list_common_timezone_shortcuts', 'Depended on a fixed shortcut list that goes stale.'),
  merge(
    'time_now_own_timezone',
    'basis.time.now',
    'Same read-only intent, consolidated with parameterized variants in the new basis.',
  ),
];

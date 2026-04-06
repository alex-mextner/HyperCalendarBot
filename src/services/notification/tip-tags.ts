import type { FeatureKey } from '../../database/repositories/feature-usage.repository.ts';
import { FEATURE_KEYS } from '../../database/repositories/feature-usage.repository.ts';

const K = FEATURE_KEYS;

/** Maps each bot tip key to a feature key for usage-based filtering */
export const BOT_TIP_FEATURE_MAP: { [tipKey: string]: FeatureKey } = {
  // ── Creating events ──
  voice_create: K.EVENTS_CREATE,
  add_command: K.EVENTS_CREATE,
  natural_language: K.EVENTS_CREATE,
  recurring_events: K.RECURRENCE,
  complex_recurrence: K.RECURRENCE,
  ics_import: K.IMPORT,
  // ── Reminders & not forgetting ──
  call_before_flight: K.VOICE_CALLS,
  multiple_reminders: K.REMINDERS,
  voice_calls: K.VOICE_CALLS,
  daily_medicine: K.REMINDERS,
  birthday_reminder: K.REMINDERS,
  // ── Planning & overview ──
  week_overview: K.EVENTS_CREATE,
  free_slots: K.FREE_SLOTS,
  month_view: K.MONTH_VIEW,
  meeting_count: K.EVENTS_CREATE,
  morning_agenda: K.MORNING_AGENDA,
  evening_review: K.EVENING_REVIEW,
  // ── Sharing & collaboration ──
  share_schedule: K.SHARING,
  invite_people: K.SHARING,
  accept_decline: K.SHARING,
  group_calendar: K.SHARING,
  secretary_access: K.SECRETARY,
  // ── Google Calendar ──
  connect_google: K.GOOGLE_CALENDAR,
  google_sync: K.GOOGLE_CALENDAR,
  // ── Life situations: Travel ──
  pack_suitcase: K.EVENTS_CREATE,
  hotel_checkin: K.EVENTS_CREATE,
  visa_appointment: K.REMINDERS,
  timezone_change: K.SETTINGS,
  // ── Life situations: Health ──
  doctor_checkup: K.RECURRENCE,
  gym_sessions: K.RECURRENCE,
  drink_water: K.REMINDERS,
  // ── Life situations: Work ──
  weekly_oneone: K.RECURRENCE,
  sprint_review: K.RECURRENCE,
  prep_time: K.EVENTS_CREATE,
  event_descriptions: K.EVENTS_EDIT,
  // ── Life situations: Personal ──
  anniversary: K.RECURRENCE,
  movie_premieres: K.EVENTS_CREATE,
  rent_payment: K.RECURRENCE,
  subscriptions: K.RECURRENCE,
  reading_challenge: K.RECURRENCE,
  // ── Life situations: Family ──
  family_calendar: K.SHARING,
  kids_swimming: K.RECURRENCE,
  school_events: K.SHARING,
  // ── Life situations: Social ──
  birthday_party: K.CONTACTS,
  decline_propose: K.SHARING,
  find_free_time: K.FREE_SLOTS,
  // ── Power features ──
  context_awareness: K.EVENTS_EDIT,
  automated_reminders: K.REMINDERS,
  public_holidays: K.HOLIDAYS,
  save_contacts: K.CONTACTS,
  quiet_hours: K.QUIET_HOURS,
  language_switch: K.SETTINGS,
  action_log: K.HISTORY,
  past_events: K.HISTORY,
};

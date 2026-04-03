import type { FeatureKey } from '../../database/repositories/feature-usage.repository.ts';
import { FEATURE_KEYS } from '../../database/repositories/feature-usage.repository.ts';

const K = FEATURE_KEYS;

/**
 * Maps each bot tip index to a feature key.
 * Order must match the `botTips` array in constants.ts (EN and RU have the same structure).
 */
export const BOT_TIP_FEATURE_MAP: FeatureKey[] = [
  // ── Creating events (0-5) ──
  K.EVENTS_CREATE, // voice message → create event
  K.EVENTS_CREATE, // /add
  K.EVENTS_CREATE, // natural language
  K.RECURRENCE, // recurring events
  K.RECURRENCE, // complex recurrences
  K.IMPORT, // .ics import
  // ── Reminders & not forgetting (6-10) ──
  K.VOICE_CALLS, // call before flight
  K.REMINDERS, // multiple reminders
  K.VOICE_CALLS, // voice calls
  K.REMINDERS, // daily medicine reminder
  K.REMINDERS, // birthday reminder
  // ── Planning & overview (11-16) ──
  K.EVENTS_CREATE, // week overview
  K.FREE_SLOTS, // free slots
  K.MONTH_VIEW, // /month
  K.EVENTS_CREATE, // meeting count
  K.MORNING_AGENDA, // morning agenda
  K.EVENING_REVIEW, // evening review
  // ── Sharing & collaboration (17-21) ──
  K.SHARING, // share schedule
  K.SHARING, // invite people
  K.SHARING, // accept/decline invitations
  K.SHARING, // group calendar
  K.SECRETARY, // secretary access
  // ── Google Calendar (22-23) ──
  K.GOOGLE_CALENDAR, // connect google
  K.GOOGLE_CALENDAR, // google events sync
  // ── Life situations: Travel (24-27) ──
  K.EVENTS_CREATE, // pack suitcase
  K.EVENTS_CREATE, // hotel check-in
  K.REMINDERS, // visa appointment
  K.SETTINGS, // timezone change
  // ── Life situations: Health (28-30) ──
  K.RECURRENCE, // doctor every 6 months
  K.RECURRENCE, // gym sessions
  K.REMINDERS, // drink water
  // ── Life situations: Work (31-34) ──
  K.RECURRENCE, // weekly 1-on-1
  K.RECURRENCE, // sprint review
  K.EVENTS_CREATE, // prep time
  K.EVENTS_EDIT, // event descriptions
  // ── Life situations: Personal (35-39) ──
  K.RECURRENCE, // anniversary
  K.EVENTS_CREATE, // movie premieres
  K.RECURRENCE, // rent payment
  K.RECURRENCE, // subscriptions
  K.RECURRENCE, // reading challenge
  // ── Life situations: Family (40-42) ──
  K.SHARING, // family group calendar
  K.RECURRENCE, // kids swimming
  K.SHARING, // school events
  // ── Life situations: Social (43-45) ──
  K.CONTACTS, // birthday party + invite contacts
  K.SHARING, // decline/propose time
  K.FREE_SLOTS, // find free time
  // ── Power features (46-53) ──
  K.EVENTS_EDIT, // context awareness
  K.REMINDERS, // automated reminders
  K.HOLIDAYS, // public holidays
  K.CONTACTS, // save contacts
  K.QUIET_HOURS, // quiet hours
  K.SETTINGS, // language switch
  K.HISTORY, // /log
  K.HISTORY, // past events lookup
];

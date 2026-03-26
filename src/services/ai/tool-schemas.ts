import { z } from 'zod';
import type { ToolName } from './tool-executor.ts';

// ── Shared fragments ──

const scopeField = z.enum(['personal', 'group']).optional();

const emptyObject = z.object({}).passthrough();

// ── Event tools ──

const getEventsSchema = z
  .object({
    start_date: z.string(),
    end_date: z.string(),
    scope: scopeField,
    owner_id: z.number().optional(),
  })
  .passthrough();

const createEventSchema = z
  .object({
    title: z.string(),
    start_at: z.string(),
    end_at: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    all_day: z.boolean().optional(),
    recurrence_rule: z.string().optional(),
    reminder_minutes: z.array(z.number()).optional(),
    force: z.boolean().optional(),
    scope: scopeField,
    owner_id: z.number().optional(),
  })
  .passthrough();

const updateEventSchema = z
  .object({
    event_id: z.number(),
    title: z.string().optional(),
    start_at: z.string().optional(),
    end_at: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    recurrence_rule: z.string().nullable().optional(),
    scope: scopeField,
    owner_id: z.number().optional(),
  })
  .passthrough();

const deleteEventSchema = z
  .object({
    event_id: z.number(),
    scope: scopeField,
    owner_id: z.number().optional(),
  })
  .passthrough();

const getFreeSlotsSchema = z
  .object({
    date: z.string(),
    scope: scopeField,
    owner_id: z.number().optional(),
  })
  .passthrough();

const searchEventsSchema = z
  .object({
    query: z.string().optional(),
    scope: scopeField,
    owner_id: z.number().optional(),
    event_type: z.enum(['birthday', 'regular']).optional(),
  })
  .passthrough();

const createBirthdayEventSchema = z
  .object({
    celebrant_id: z.number(),
    date: z.object({ day: z.number(), month: z.number() }),
    year: z.number().optional(),
    custom_name: z.string().optional(),
    group_id: z.number().optional(),
  })
  .passthrough();

const getUpcomingSchema = z
  .object({
    limit: z.number().optional(),
    scope: scopeField,
    owner_id: z.number().optional(),
  })
  .passthrough();

const snoozeEventSchema = z
  .object({
    event_id: z.number(),
    minutes: z.number().optional(),
    scope: scopeField,
    owner_id: z.number().optional(),
  })
  .passthrough();

const getEventSchema = z
  .object({
    event_id: z.number(),
    scope: scopeField,
    owner_id: z.number().optional(),
  })
  .passthrough();

const notifyParticipantsSchema = z
  .object({
    event_id: z.number(),
    message: z.string(),
  })
  .passthrough();

// ── Reminder tools ──

const getRemindersSchema = z
  .object({
    event_id: z.number(),
    scope: scopeField,
    owner_id: z.number().optional(),
  })
  .passthrough();

const setReminderSchema = z
  .object({
    event_id: z.number(),
    minutes_before: z.array(z.number()),
    scope: scopeField,
    owner_id: z.number().optional(),
  })
  .passthrough();

// ── Contact / user tools ──

const findUserSchema = z.object({ username: z.string() }).passthrough();

const askUserSchema = z
  .object({
    question: z.string(),
    options: z.array(z.string()),
  })
  .passthrough();

const pickUsersSchema = z
  .object({
    event_id: z.number(),
    prompt: z.string(),
  })
  .passthrough();

const getContactsSchema = z.object({ force: z.boolean().optional() }).passthrough();

const addContactSchema = z
  .object({
    name: z.string(),
    username: z.string().optional(),
    preferred_name: z.string().optional(),
  })
  .passthrough();

const findContactSchema = z.object({ name: z.string() }).passthrough();

const updateContactSchema = z
  .object({
    search: z.string(),
    name: z.string().optional(),
    preferred_name: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

// ── Render tools ──

const renderDayImageSchema = z
  .object({
    date: z.string(),
    scope: scopeField,
    owner_id: z.number().optional(),
  })
  .passthrough();

const renderWeekImageSchema = z
  .object({
    week_start: z.string(),
    scope: scopeField,
    owner_id: z.number().optional(),
  })
  .passthrough();

const renderTableSchema = z
  .object({
    title: z.string(),
    markdown: z.string(),
    caption: z.string().optional(),
  })
  .passthrough();

// ── Call tools ──

const makeCallSchema = z.object({ text: z.string() }).passthrough();

// ── Settings ──

const manageSettingsSchema = z
  .object({
    action: z.enum(['get', 'update']),
    category: z.enum(['general', 'notifications', 'calls', 'privacy', 'voice', 'assistant']).optional(),
    updates: z.record(z.string(), z.unknown()).optional(),
    assistantEnabled: z.boolean().optional(),
  })
  .passthrough();

// ── Sharing tools ──

const shareEventSchema = z
  .object({
    event_id: z.number(),
    target_type: z.enum(['user', 'group']),
    target_id: z.number(),
  })
  .passthrough();

const sendInvitationSchema = z
  .object({
    event_id: z.number(),
    invitee_id: z.number(),
    invitee_username: z.string().optional(),
  })
  .passthrough();

const getInvitationStatusSchema = z.object({ event_id: z.number() }).passthrough();

const shareAgendaSchema = z
  .object({
    period: z.enum(['today', 'tomorrow', 'week']),
    target_type: z.enum(['user', 'group']),
    target_id: z.number(),
  })
  .passthrough();

const setEventVisibilitySchema = z
  .object({
    event_id: z.number(),
    visibility: z.enum(['private', 'free_busy', 'full']),
    owner_id: z.number().optional(),
  })
  .passthrough();

const proposeEditSchema = z
  .object({
    event_id: z.number(),
    changes: z.record(z.string(), z.union([z.string(), z.null()])),
    reason: z.string().optional(),
  })
  .passthrough();

const cancelInvitationSchema = z.object({ invitation_id: z.number() }).passthrough();

const resendInvitationSchema = z
  .object({
    invitation_id: z.number(),
    invitee_username: z.string().optional(),
  })
  .passthrough();

// ── Secretary tools ──

const manageSecretariesSchema = z
  .object({
    action: z.enum(['invite', 'revoke', 'self_remove']),
    secretary_telegram_id: z.number().optional(),
    permission: z.enum(['read', 'write']).optional(),
    secretary_access_id: z.number().optional(),
  })
  .passthrough();

// ── Proposal tools ──

const proposeCalendarChangeSchema = z
  .object({
    target_telegram_id: z.number(),
    action: z.enum(['create', 'update', 'delete']),
    summary: z.string(),
    event: z.record(z.string(), z.unknown()).optional(),
    event_id: z.number().optional(),
    changes: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// ── Misc tools ──

const getHolidaysSchema = z.object({ limit: z.number().optional() }).passthrough();

const sendFeedbackSchema = z
  .object({
    type: z.enum(['bug', 'feature', 'question', 'other']),
    message: z.string(),
  })
  .passthrough();

const calculateSchema = z.object({ expression: z.string() }).passthrough();

const getTimezoneInfoSchema = z
  .object({
    timezone: z.union([z.string(), z.array(z.string())]),
    at: z.string().optional(),
  })
  .passthrough();

const convertToTimezoneSchema = z
  .object({
    datetime: z.string(),
    timezone: z.string(),
  })
  .passthrough();

const lookupStressSchema = z.object({ words: z.array(z.string()) }).passthrough();

const getHistorySchema = z
  .object({
    limit: z.number().optional(),
    search: z.string().optional(),
    before: z.string().optional(),
    after: z.string().optional(),
  })
  .passthrough();

const getActionLogSchema = z
  .object({
    event_id: z.number().optional(),
    action_type: z.string().optional(),
    action_name: z.string().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    limit: z.number().optional(),
  })
  .passthrough();

// ── Scheduled / Trigger tools ──

const scheduleAiCallSchema = z
  .object({
    message: z.string(),
    run_at: z.string().optional(),
    cron: z.string().optional(),
    label: z.string().optional(),
  })
  .passthrough();

const triggerIdSchema = z.object({ id: z.string() }).passthrough();

const addTriggerSchema = z
  .object({
    topic: z.string(),
    action: z.string(),
    condition: z.string().optional(),
    label: z.string().optional(),
    once: z.boolean().optional(),
  })
  .passthrough();

// ── Memory tools ──

const setReactionSchema = z
  .object({
    message_id: z.number(),
    emoji: z.string(),
  })
  .passthrough();

const rememberUserFactSchema = z
  .object({
    type: z.enum(['append', 'rewrite']),
    content: z.string(),
  })
  .passthrough();

// ── Assistant tools (passthrough — validated by the agent protocol) ──

const assistantPayloadSchema = z.record(z.string(), z.unknown());

// ── Schema map ──

export const toolSchemas: Partial<Record<ToolName, z.ZodType>> = {
  // No-input tools don't need validation
  supplement_skip: emptyObject,
  end_conversation: emptyObject,
  end_call: emptyObject,
  get_google_calendar_status: emptyObject,
  list_google_calendars: emptyObject,
  get_bot_info: emptyObject,
  list_calendar_access: emptyObject,
  schedule_ai_calls_list: emptyObject,
  list_triggers: emptyObject,
  resume_scene: emptyObject,
  cancel_scene: emptyObject,

  // Event tools
  get_events: getEventsSchema,
  create_event: createEventSchema,
  update_event: updateEventSchema,
  delete_event: deleteEventSchema,
  get_free_slots: getFreeSlotsSchema,
  search_events: searchEventsSchema,
  create_birthday_event: createBirthdayEventSchema,
  get_upcoming: getUpcomingSchema,
  snooze_event: snoozeEventSchema,
  get_event: getEventSchema,
  notify_participants: notifyParticipantsSchema,

  // Reminder tools
  get_reminders: getRemindersSchema,
  set_reminder: setReminderSchema,

  // Contact / user tools
  find_user: findUserSchema,
  ask_user: askUserSchema,
  pick_users: pickUsersSchema,
  get_contacts: getContactsSchema,
  add_contact: addContactSchema,
  find_contact: findContactSchema,
  update_contact: updateContactSchema,

  // Render tools
  render_day_image: renderDayImageSchema,
  render_week_image: renderWeekImageSchema,
  render_table: renderTableSchema,

  // Call tools
  make_call: makeCallSchema,

  // Settings
  manage_settings: manageSettingsSchema,

  // Sharing tools
  share_event: shareEventSchema,
  send_invitation: sendInvitationSchema,
  get_invitation_status: getInvitationStatusSchema,
  share_agenda: shareAgendaSchema,
  set_event_visibility: setEventVisibilitySchema,
  propose_edit: proposeEditSchema,
  cancel_invitation: cancelInvitationSchema,
  resend_invitation: resendInvitationSchema,

  // Secretary tools
  manage_secretaries: manageSecretariesSchema,

  // Proposal tools
  propose_calendar_change: proposeCalendarChangeSchema,

  // Misc tools
  get_holidays: getHolidaysSchema,
  send_feedback: sendFeedbackSchema,
  calculate: calculateSchema,
  get_timezone_info: getTimezoneInfoSchema,
  convert_to_timezone: convertToTimezoneSchema,
  lookup_stress: lookupStressSchema,
  get_history: getHistorySchema,
  get_action_log: getActionLogSchema,

  // Scheduled / Trigger tools
  schedule_ai_call: scheduleAiCallSchema,
  schedule_ai_call_cancel: triggerIdSchema,
  add_trigger: addTriggerSchema,
  remove_trigger: triggerIdSchema,

  // Memory tools
  set_reaction: setReactionSchema,
  remember_user_fact: rememberUserFactSchema,

  // Assistant tools
  claude_chat: assistantPayloadSchema,
  claude_new_chat: assistantPayloadSchema,
  claude_list_chats: assistantPayloadSchema,
  claude_open_chat: assistantPayloadSchema,
  claude_list_projects: assistantPayloadSchema,
  claude_artifact: assistantPayloadSchema,
  bash_execute: assistantPayloadSchema,
  playwright_action: assistantPayloadSchema,
  applescript_run: assistantPayloadSchema,
};

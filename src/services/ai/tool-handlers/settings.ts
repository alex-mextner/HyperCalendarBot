import { t, toLang } from '../../../config/constants.ts';
import type {
  NotificationPreferencesRow,
  NotificationPreferencesUpdate,
  SharingSettings,
  UpdateUserData,
  UserCallSettings,
  Visibility,
} from '../../../database/types.ts';
import type { AgentContext, ToolResult } from '../types.ts';

// ── Update interfaces (match AI tool schema in tools.ts) ──

interface GeneralUpdates {
  timezone?: string;
  language?: 'en' | 'ru';
  country_code?: string;
  default_event_duration_minutes?: number;
}

interface NotificationUpdates {
  morning_agenda_enabled?: boolean;
  morning_agenda_time?: string;
  evening_review_enabled?: boolean;
  evening_review_time?: string;
  quiet_hours_enabled?: boolean;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  default_reminder_minutes?: number[];
}

interface CallUpdates {
  enabled?: boolean;
  language?: string;
}

interface PrivacyUpdates {
  default_visibility?: Visibility;
  inline_mode_enabled?: boolean;
  allow_invitations?: boolean;
}

interface VoiceUpdates {
  voice_response_enabled?: boolean | null;
}

// ── Get result interfaces ──

type SettingsCategory = 'general' | 'notifications' | 'calls' | 'privacy' | 'voice';

interface GeneralSettingsResult {
  timezone: string;
  language: 'en' | 'ru';
  username: string;
  first_name: string;
  country_code: string;
  default_event_duration_minutes: number;
}

interface VoiceSettingsResult {
  voice_response_enabled: number | null;
}

type CallSettingsResult = Omit<UserCallSettings, 'user_id' | 'updated_at'>;
type PrivacySettingsResult = Omit<SharingSettings, 'user_id' | 'updated_at'>;

type ResultCategory = Exclude<SettingsCategory, 'assistant'>;

interface AllSettingsResult {
  general?: GeneralSettingsResult;
  notifications?: NotificationPreferencesRow;
  calls?: CallSettingsResult;
  privacy?: PrivacySettingsResult;
  voice?: VoiceSettingsResult;
}

export type ManageSettingsInput =
  | { action: 'get'; category?: SettingsCategory }
  | { action: 'update'; category: 'general'; updates?: GeneralUpdates }
  | { action: 'update'; category: 'notifications'; updates?: NotificationUpdates }
  | { action: 'update'; category: 'calls'; updates?: CallUpdates }
  | { action: 'update'; category: 'privacy'; updates?: PrivacyUpdates }
  | { action: 'update'; category: 'voice'; updates?: VoiceUpdates }
  | {
      action: 'update';
      category?: undefined;
      updates?: GeneralUpdates | NotificationUpdates | CallUpdates | PrivacyUpdates | VoiceUpdates;
    };

export function handleManageSettings(ctx: AgentContext, input: ManageSettingsInput): ToolResult {
  switch (input.action) {
    case 'get':
      return handleGet(ctx, input.category);
    case 'update':
      return handleUpdate(ctx, input);
  }
}

function handleGet(ctx: AgentContext, category?: SettingsCategory): ToolResult {
  const result: AllSettingsResult = {};

  if (!category || category === 'general') {
    result.general = {
      timezone: ctx.user.timezone,
      language: ctx.user.language,
      username: ctx.user.username ?? 'not set',
      first_name: ctx.user.first_name ?? 'not set',
      country_code: ctx.user.country_code ?? 'not set',
      default_event_duration_minutes: ctx.user.default_event_duration_minutes ?? 60,
    };
  }

  if (!category || category === 'notifications') {
    if (ctx.notifications?.notificationPrefs) {
      ctx.notifications?.notificationPrefs.ensureDefaults(ctx.user.telegram_id);
      result.notifications = ctx.notifications?.notificationPrefs.getPrefs(ctx.user.telegram_id);
    }
  }

  if (category === 'calls' && !ctx.calls) return callsUnavailable(ctx);
  if ((!category || category === 'calls') && ctx.calls) {
    ctx.calls.callSettingsRepo.ensureDefaults(ctx.user.telegram_id);
    const settings = ctx.calls.callSettingsRepo.get(ctx.user.telegram_id);
    if (settings) {
      const { user_id: _uid, updated_at: _uat, ...rest } = settings;
      result.calls = rest;
    }
  }

  if (!category || category === 'privacy') {
    if (ctx.sharing?.sharingSettingsRepo) {
      ctx.sharing?.sharingSettingsRepo.ensureDefaults(ctx.user.telegram_id);
      const settings = ctx.sharing?.sharingSettingsRepo.get(ctx.user.telegram_id);
      if (settings) {
        const { user_id: _uid, updated_at: _uat, ...rest } = settings;
        result.privacy = rest;
      }
    }
  }

  if (!category || category === 'voice') {
    result.voice = {
      voice_response_enabled: ctx.user.voice_response_enabled ?? null,
    };
  }

  if (category) {
    const resultCategory: ResultCategory = category;
    const categoryResult = result[resultCategory];
    return { success: true, output: JSON.stringify(categoryResult ?? {}) };
  }

  return { success: true, output: JSON.stringify(result) };
}

type UpdateInput = Extract<ManageSettingsInput, { action: 'update' }>;

function handleUpdate(ctx: AgentContext, input: UpdateInput): ToolResult {
  if (!input.category) return { success: false, error: 'category is required for update.' };

  if (!input.updates || Object.keys(input.updates).length === 0) {
    return { success: false, error: 'updates are required for update.' };
  }

  switch (input.category) {
    case 'general':
      return updateGeneral(ctx, input.updates);
    case 'notifications':
      return updateNotifications(ctx, input.updates);
    case 'calls':
      return updateCalls(ctx, input.updates);
    case 'privacy':
      return updatePrivacy(ctx, input.updates);
    case 'voice':
      return updateVoice(ctx, input.updates);
  }
}

function updateGeneral(ctx: AgentContext, updates: GeneralUpdates): ToolResult {
  const patch: UpdateUserData = {};
  if (updates.timezone !== undefined) patch.timezone = updates.timezone;
  if (updates.language !== undefined) patch.language = updates.language;
  if (updates.country_code !== undefined) patch.country_code = updates.country_code;
  if (updates.default_event_duration_minutes !== undefined) {
    const mins = updates.default_event_duration_minutes;
    if (!Number.isInteger(mins) || mins <= 0 || mins > 1440) {
      return { success: false, error: 'default_event_duration_minutes must be a positive integer between 1 and 1440.' };
    }
    patch.default_event_duration_minutes = mins;
  }

  if (Object.keys(patch).length === 0) {
    return { success: false, error: 'No valid general settings to update.' };
  }

  const updated = ctx.userRepo.update(ctx.user.telegram_id, patch);
  if (!updated) return { success: false, error: 'Failed to update general settings.' };

  ctx.user = updated;

  const lines = Object.entries(patch).map(([k, v]) => `${k}: ${v}`);
  let output = `General settings updated: ${lines.join(', ')}`;

  if (patch.language !== undefined) {
    const newLang = patch.language === 'ru' ? 'Russian' : 'English';
    output += `. LANGUAGE CHANGED: respond in ${newLang} from this point forward`;
  }

  return { success: true, output };
}

function updateNotifications(ctx: AgentContext, updates: NotificationUpdates): ToolResult {
  if (!ctx.notifications?.notificationPrefs) return { success: false, error: 'Notification settings not configured.' };
  ctx.notifications?.notificationPrefs.ensureDefaults(ctx.user.telegram_id);

  const patch: NotificationPreferencesUpdate = {};
  if (updates.morning_agenda_enabled !== undefined)
    patch.morning_agenda_enabled = updates.morning_agenda_enabled ? 1 : 0;
  if (updates.morning_agenda_time !== undefined) patch.morning_agenda_time = updates.morning_agenda_time;
  if (updates.evening_review_enabled !== undefined)
    patch.evening_review_enabled = updates.evening_review_enabled ? 1 : 0;
  if (updates.evening_review_time !== undefined) patch.evening_review_time = updates.evening_review_time;
  if (updates.quiet_hours_enabled !== undefined) patch.quiet_hours_enabled = updates.quiet_hours_enabled ? 1 : 0;
  if (updates.quiet_hours_start !== undefined) patch.quiet_hours_start = updates.quiet_hours_start;
  if (updates.quiet_hours_end !== undefined) patch.quiet_hours_end = updates.quiet_hours_end;
  if (updates.default_reminder_minutes !== undefined) {
    patch.default_reminder_intervals = JSON.stringify(updates.default_reminder_minutes);
  }

  if (Object.keys(patch).length === 0) return { success: false, error: 'No notification settings provided.' };
  ctx.notifications?.notificationPrefs.update(ctx.user.telegram_id, patch);
  return {
    success: true,
    output: t(ctx.user.language).aiTools.settings.notificationsUpdated(Object.keys(patch).join(', ')),
  };
}

function updateCalls(ctx: AgentContext, updates: CallUpdates): ToolResult {
  if (!ctx.calls) return callsUnavailable(ctx);
  const repo = ctx.calls.callSettingsRepo;
  repo.ensureDefaults(ctx.user.telegram_id);
  if (updates.enabled !== undefined) repo.setEnabled(ctx.user.telegram_id, updates.enabled);
  if (updates.language !== undefined) repo.setLanguage(ctx.user.telegram_id, updates.language);
  return { success: true, output: t(ctx.user.language).aiTools.settings.callsUpdated };
}

function callsUnavailable(ctx: AgentContext): ToolResult {
  return {
    success: false,
    error: t(ctx.user.language).settings.callsUnavailable,
    agentHint: 'This bot has no calling account, so voice calls cannot be enabled or configured by any setting.',
  };
}

function updatePrivacy(ctx: AgentContext, updates: PrivacyUpdates): ToolResult {
  if (!ctx.sharing?.sharingSettingsRepo) return { success: false, error: 'Sharing settings are not configured.' };

  const patch: Partial<Omit<SharingSettings, 'user_id' | 'updated_at'>> = {};
  if (updates.default_visibility !== undefined) patch.default_visibility = updates.default_visibility;
  if (updates.inline_mode_enabled !== undefined) patch.inline_mode_enabled = updates.inline_mode_enabled ? 1 : 0;
  if (updates.allow_invitations !== undefined) patch.allow_invitations = updates.allow_invitations ? 1 : 0;

  if (Object.keys(patch).length === 0) {
    return { success: false, error: 'No privacy settings provided.' };
  }

  ctx.sharing?.sharingSettingsRepo.ensureDefaults(ctx.user.telegram_id);
  ctx.sharing?.sharingSettingsRepo.update(ctx.user.telegram_id, patch);

  const lines = Object.entries(patch).map(([k, v]) => `${k}: ${v}`);
  return { success: true, output: t(ctx.user.language).aiTools.settings.privacyUpdated(lines.join(', ')) };
}

function updateVoice(ctx: AgentContext, updates: VoiceUpdates): ToolResult {
  if (updates.voice_response_enabled === undefined) {
    return { success: false, error: 'No voice settings provided.' };
  }

  const raw = updates.voice_response_enabled;
  const enabled: number | null = raw === null ? null : raw ? 1 : 0;
  const updated = ctx.userRepo.update(ctx.user.telegram_id, { voice_response_enabled: enabled });
  if (!updated) return { success: false, error: 'Failed to update voice settings.' };

  ctx.user = updated;
  return { success: true, output: t(ctx.user.language).aiTools.settings.voiceUpdated(String(raw)) };
}

const CONNECT_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
/** Tolerated clock drift between requests; a snooze stamped further ahead is treated as invalid. */
const CONNECT_PROMPT_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * `users.connect_telegram_dismissed_at` is the start of a 30-day snooze. It is set both by an
 * explicit dismissal and whenever the suggestion is shown, so the suggestion appears at most once
 * per 30 days whether or not the user answers it (the intent path cannot relay a "not now").
 */
function connectPromptSnoozed(ctx: AgentContext): boolean {
  const snoozedAt = ctx.user.connect_telegram_dismissed_at;
  if (!snoozedAt) return false;
  const elapsed = Date.now() - new Date(snoozedAt).getTime();
  // A timestamp far in the future is clock skew, not a snooze; malformed text yields NaN. Neither
  // counts, and the compare-and-swap claim replaces both.
  return elapsed > -CONNECT_PROMPT_SKEW_MS && elapsed < CONNECT_PROMPT_SNOOZE_MS;
}

/**
 * The /connect_telegram suggestion for an invitation that was just sent, or null (#511, spec
 * §10.1). It is offered only when the bot itself could not reach a person invitee, the feature is
 * enabled, the user has no active session, is in a private chat (the command refuses to run in
 * groups), and the suggestion is not snoozed. Showing it claims the snooze with a compare-and-swap
 * on the value judged here, so concurrent requests of one user cannot both show it.
 */
export function takeConnectTelegramSuggestion(
  ctx: AgentContext,
  delivery: { viaBotApi: boolean },
  isGroupTarget: boolean,
): string | null {
  const eligible =
    // Without a Bot API send capability nothing was attempted, so "not reached" means nothing.
    ctx.sender?.sendInvitation !== undefined &&
    !delivery.viaBotApi &&
    !isGroupTarget &&
    !ctx.isGroup &&
    ctx.telegramMasterKey !== undefined &&
    ctx.telegramSessionRepo !== undefined &&
    !ctx.telegramSessionRepo.getActive(ctx.user.telegram_id) &&
    !connectPromptSnoozed(ctx);
  if (!eligible) return null;
  const at = new Date().toISOString();
  if (!ctx.userRepo.claimConnectTelegramSnooze(ctx.user.telegram_id, at, ctx.user.connect_telegram_dismissed_at)) {
    return null;
  }
  // Later steps of the same message read the user snapshot, not the row: intent workflows build a
  // fresh context per step around the same user object, so update that object in place.
  ctx.user.connect_telegram_dismissed_at = at;
  return t(toLang(ctx.user.language)).botTips.connect_telegram;
}

export function handleDismissConnectTelegramPrompt(ctx: AgentContext): ToolResult {
  const at = new Date().toISOString();
  ctx.userRepo.setConnectTelegramDismissedAt(ctx.user.telegram_id, at);
  ctx.user.connect_telegram_dismissed_at = at; // same in-place snapshot update as above
  return { success: true, output: 'Noted. Will not suggest again for 30 days.' };
}
handleDismissConnectTelegramPrompt.meta = { skipActionLog: true } satisfies import('../types.ts').ToolHandlerMeta;

export function handleConnectTelegramStatus(ctx: AgentContext): ToolResult {
  const lang = (ctx.user.language ?? 'en') as 'en' | 'ru';
  const session = ctx.telegramSessionRepo?.getActive(ctx.user.telegram_id);

  if (!session || !ctx.telegramMasterKey) {
    return {
      success: true,
      output: t(lang).aiTools.meta.telegramNotConnectedStatus,
      data: { connected: false, dismissed_recently: connectPromptSnoozed(ctx) },
    };
  }

  // Connected yes/no only: a tool result is kept in chat history and every AI debug log, so it carries
  // no part of the phone number, masked or not.
  return {
    success: true,
    output: t(lang).aiTools.meta.telegramConnectedStatus,
    data: { connected: true },
  };
}
handleConnectTelegramStatus.meta = {
  readonly: true,
  skipActionLog: true,
} satisfies import('../types.ts').ToolHandlerMeta;

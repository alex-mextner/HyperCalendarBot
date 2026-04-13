import { maskPhone, t } from '../../../config/constants.ts';
import type {
  NotificationPreferencesRow,
  NotificationPreferencesUpdate,
  SharingSettings,
  UpdateUserData,
  UserCallSettings,
  Visibility,
} from '../../../database/types.ts';
import { logger } from '../../../utils/logger.ts';
import { decryptString } from '../../crypto/session-crypto.ts';
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

type SettingsCategory = 'general' | 'notifications' | 'calls' | 'privacy' | 'voice' | 'assistant';

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
  | { action: 'update'; category: 'assistant'; assistantEnabled?: boolean }
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

  if (!category || category === 'calls') {
    if (ctx.voice?.callSettingsRepo) {
      ctx.voice?.callSettingsRepo.ensureDefaults(ctx.user.telegram_id);
      const settings = ctx.voice?.callSettingsRepo.get(ctx.user.telegram_id);
      if (settings) {
        const { user_id: _uid, updated_at: _uat, ...rest } = settings;
        result.calls = rest;
      }
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

  if (category === 'assistant') {
    const connected = ctx.agents?.agentRegistry?.isConnected(ctx.user.telegram_id) ?? false;
    const enabled = Boolean(ctx.user.assistant_enabled);
    return {
      success: true,
      output:
        ctx.user.language === 'ru'
          ? `🤖 AI Ассистент: ${enabled ? 'включён' : 'выключён'}\nАгент: ${connected ? 'подключён ✅' : 'не подключён ❌'}`
          : `🤖 AI Assistant: ${enabled ? 'enabled' : 'disabled'}\nAgent: ${connected ? '✅ connected' : '❌ not connected'}`,
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

  if (input.category === 'assistant') {
    return updateAssistant(ctx, input.assistantEnabled);
  }

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
  if (!ctx.voice?.callSettingsRepo) return { success: false, error: 'Call settings not available.' };
  ctx.voice?.callSettingsRepo.ensureDefaults(ctx.user.telegram_id);
  if (updates.enabled !== undefined) ctx.voice?.callSettingsRepo.setEnabled(ctx.user.telegram_id, updates.enabled);
  if (updates.language !== undefined) ctx.voice?.callSettingsRepo.setLanguage(ctx.user.telegram_id, updates.language);
  return { success: true, output: t(ctx.user.language).aiTools.settings.callsUpdated };
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

function updateAssistant(ctx: AgentContext, assistantEnabled?: boolean): ToolResult {
  if (typeof assistantEnabled !== 'boolean') {
    return { success: false, error: 'Unknown action' };
  }
  ctx.userRepo.updateAssistantEnabled(ctx.user.telegram_id, assistantEnabled);
  ctx.user = { ...ctx.user, assistant_enabled: assistantEnabled ? 1 : 0 };
  return {
    success: true,
    output:
      ctx.user.language === 'ru'
        ? `AI Ассистент ${assistantEnabled ? 'включён' : 'выключён'}`
        : `AI Assistant ${assistantEnabled ? 'enabled' : 'disabled'}`,
  };
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

export function handleDismissConnectTelegramPrompt(ctx: AgentContext): ToolResult {
  ctx.userRepo.setConnectTelegramDismissedAt(ctx.user.telegram_id, new Date().toISOString());
  return { success: true, output: 'Noted. Will not suggest again for 30 days.' };
}

export function handleConnectTelegramStatus(ctx: AgentContext): ToolResult {
  const lang = (ctx.user.language ?? 'en') as 'en' | 'ru';
  const session = ctx.telegramSessionRepo?.getActive(ctx.user.telegram_id);

  if (!session || !ctx.telegramMasterKey) {
    const dismissedAt = ctx.user.connect_telegram_dismissed_at;
    const dismissedRecently =
      dismissedAt !== null && dismissedAt !== undefined
        ? Date.now() - new Date(dismissedAt).getTime() < 30 * 24 * 60 * 60 * 1000
        : false;
    return {
      success: true,
      output: t(lang).aiTools.meta.telegramNotConnectedStatus,
      data: { connected: false, dismissed_recently: dismissedRecently },
    };
  }

  let masked = '+••• ••••';
  try {
    masked = maskPhone(decryptString(Buffer.from(session.encrypted_phone), ctx.telegramMasterKey));
  } catch (err) {
    logger.warn({ err, userId: ctx.user.telegram_id }, 'Phone decrypt failed in AI tool');
  }

  return {
    success: true,
    output: t(lang).aiTools.meta.telegramConnectedStatus(masked),
    data: { connected: true, phone_masked: masked, status: session.status },
  };
}

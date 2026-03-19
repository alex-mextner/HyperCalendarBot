import type { UpdateUserData } from '../../../database/types.ts';
import { localTimeToUtcHHMM } from '../../notification/timezone.ts';
import type { AgentContext, ToolResult } from '../types.ts';

interface ManageSettingsInput {
  action: 'get' | 'update';
  category?: 'general' | 'notifications' | 'calls' | 'privacy' | 'voice';
  updates?: Record<string, unknown>;
}

export function handleManageSettings(ctx: AgentContext, input: ManageSettingsInput): ToolResult {
  if (input.action === 'get') return handleGet(ctx, input.category);
  if (input.action === 'update') return handleUpdate(ctx, input.category, input.updates);
  return { success: false, error: `Unknown action: ${input.action}` };
}

function handleGet(ctx: AgentContext, category?: string): ToolResult {
  const result: Record<string, unknown> = {};

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
    if (ctx.notificationPrefs) {
      ctx.notificationPrefs.ensureDefaults(ctx.user.telegram_id);
      result.notifications = ctx.notificationPrefs.getPrefs(ctx.user.telegram_id);
    }
  }

  if (!category || category === 'calls') {
    if (ctx.callSettingsRepo) {
      ctx.callSettingsRepo.ensureDefaults(ctx.user.telegram_id);
      const settings = ctx.callSettingsRepo.get(ctx.user.telegram_id);
      if (settings) {
        const { user_id: _uid, updated_at: _uat, ...rest } = settings as Record<string, unknown>;
        result.calls = rest;
      }
    }
  }

  if (!category || category === 'privacy') {
    if (ctx.sharingSettingsRepo) {
      ctx.sharingSettingsRepo.ensureDefaults(ctx.user.telegram_id);
      const settings = ctx.sharingSettingsRepo.get(ctx.user.telegram_id);
      if (settings) {
        const { user_id: _uid, updated_at: _uat, ...rest } = settings as Record<string, unknown>;
        result.privacy = rest;
      }
    }
  }

  if (!category || category === 'voice') {
    result.voice = {
      voice_response_enabled: ctx.user.voice_response_enabled ?? null,
    };
  }

  return { success: true, output: JSON.stringify(category ? (result[category] ?? {}) : result) };
}

function handleUpdate(ctx: AgentContext, category?: string, updates?: Record<string, unknown>): ToolResult {
  if (!category) return { success: false, error: 'category is required for update.' };
  if (!updates || Object.keys(updates).length === 0) {
    return { success: false, error: 'updates are required for update.' };
  }

  if (category === 'general') return updateGeneral(ctx, updates);
  if (category === 'notifications') return updateNotifications(ctx, updates);
  if (category === 'calls') return updateCalls(ctx, updates);
  if (category === 'privacy') return updatePrivacy(ctx, updates);
  if (category === 'voice') return updateVoice(ctx, updates);

  return { success: false, error: `Unknown category: ${category}` };
}

function updateGeneral(ctx: AgentContext, updates: Record<string, unknown>): ToolResult {
  const patch: UpdateUserData = {};
  if (updates.timezone !== undefined) patch.timezone = updates.timezone as string;
  if (updates.language !== undefined) patch.language = updates.language as 'en' | 'ru';
  if (updates.country_code !== undefined) patch.country_code = updates.country_code as string;
  if (updates.default_event_duration_minutes !== undefined) {
    const mins = updates.default_event_duration_minutes as number;
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

function updateNotifications(ctx: AgentContext, updates: Record<string, unknown>): ToolResult {
  if (!ctx.notificationPrefs) return { success: false, error: 'Notification settings not configured.' };
  ctx.notificationPrefs.ensureDefaults(ctx.user.telegram_id);

  const patch: Record<string, unknown> = {};
  if (updates.morning_agenda_enabled !== undefined)
    patch.morning_agenda_enabled = updates.morning_agenda_enabled ? 1 : 0;
  if (updates.morning_agenda_time !== undefined) {
    patch.morning_agenda_time = updates.morning_agenda_time;
    patch.morning_agenda_utc = localTimeToUtcHHMM(updates.morning_agenda_time as string, ctx.user.timezone);
  }
  if (updates.evening_review_enabled !== undefined)
    patch.evening_review_enabled = updates.evening_review_enabled ? 1 : 0;
  if (updates.evening_review_time !== undefined) {
    patch.evening_review_time = updates.evening_review_time;
    patch.evening_review_utc = localTimeToUtcHHMM(updates.evening_review_time as string, ctx.user.timezone);
  }
  if (updates.quiet_hours_enabled !== undefined) patch.quiet_hours_enabled = updates.quiet_hours_enabled ? 1 : 0;
  if (updates.quiet_hours_start !== undefined) patch.quiet_hours_start = updates.quiet_hours_start;
  if (updates.quiet_hours_end !== undefined) patch.quiet_hours_end = updates.quiet_hours_end;
  if (updates.default_reminder_minutes !== undefined) {
    patch.default_reminder_intervals = JSON.stringify(updates.default_reminder_minutes);
  }

  if (Object.keys(patch).length === 0) return { success: false, error: 'No notification settings provided.' };
  ctx.notificationPrefs.update(ctx.user.telegram_id, patch);
  return { success: true, output: `Notification settings updated: ${Object.keys(patch).join(', ')}` };
}

function updateCalls(ctx: AgentContext, updates: Record<string, unknown>): ToolResult {
  if (!ctx.callSettingsRepo) return { success: false, error: 'Call settings not available.' };
  ctx.callSettingsRepo.ensureDefaults(ctx.user.telegram_id);
  if (updates.enabled !== undefined) ctx.callSettingsRepo.setEnabled(ctx.user.telegram_id, updates.enabled as boolean);
  if (updates.language !== undefined)
    ctx.callSettingsRepo.setLanguage(ctx.user.telegram_id, updates.language as string);
  return { success: true, output: 'Call settings updated.' };
}

function updatePrivacy(ctx: AgentContext, updates: Record<string, unknown>): ToolResult {
  if (!ctx.sharingSettingsRepo) return { success: false, error: 'Sharing settings are not configured.' };

  const patch: Record<string, string | number> = {};
  if (updates.default_visibility !== undefined) patch.default_visibility = updates.default_visibility as string;
  if (updates.inline_mode_enabled !== undefined) patch.inline_mode_enabled = updates.inline_mode_enabled ? 1 : 0;
  if (updates.allow_invitations !== undefined) patch.allow_invitations = updates.allow_invitations ? 1 : 0;

  if (Object.keys(patch).length === 0) {
    return { success: false, error: 'No privacy settings provided.' };
  }

  ctx.sharingSettingsRepo.ensureDefaults(ctx.user.telegram_id);
  ctx.sharingSettingsRepo.update(ctx.user.telegram_id, patch);

  const lines = Object.entries(patch).map(([k, v]) => `${k}: ${v}`);
  return { success: true, output: `Privacy settings updated: ${lines.join(', ')}` };
}

function updateVoice(ctx: AgentContext, updates: Record<string, unknown>): ToolResult {
  if (updates.voice_response_enabled === undefined) {
    return { success: false, error: 'No voice settings provided.' };
  }

  const raw = updates.voice_response_enabled;
  const enabled: number | null = raw === null ? null : raw ? 1 : 0;
  const updated = ctx.userRepo.update(ctx.user.telegram_id, { voice_response_enabled: enabled });
  if (!updated) return { success: false, error: 'Failed to update voice settings.' };

  ctx.user = updated;
  return { success: true, output: `Voice settings updated: voice_response_enabled = ${raw}` };
}

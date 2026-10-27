// src/config/constants/messages/index.ts
// Assembles the i18n message tables from per-topic modules; key order follows the topic order.

import { enAddWizard } from './en/add-wizard.ts';
import { enAgentStatus } from './en/agent-status.ts';
import { enAiTools } from './en/ai-tools.ts';
import { enCallbackErrors } from './en/callback-errors.ts';
import { enConnectTelegram } from './en/connect-telegram.ts';
import { enFormatting } from './en/formatting.ts';
import { enGcal } from './en/gcal.ts';
import { enHolidaysNotify } from './en/holidays-notify.ts';
import { enInvitations } from './en/invitations.ts';
import { enOnboarding } from './en/onboarding.ts';
import { enSettings } from './en/settings.ts';
import { enSharingVoice } from './en/sharing-voice.ts';
import { enSpeechSyncStats } from './en/speech-sync-stats.ts';
import { enTips } from './en/tips.ts';
import { enWorkflow } from './en/workflow.ts';
import { ruAddWizard } from './ru/add-wizard.ts';
import { ruAgentStatus } from './ru/agent-status.ts';
import { ruAiTools } from './ru/ai-tools.ts';
import { ruCallbackErrors } from './ru/callback-errors.ts';
import { ruConnectTelegram } from './ru/connect-telegram.ts';
import { ruFormatting } from './ru/formatting.ts';
import { ruGcal } from './ru/gcal.ts';
import { ruHolidaysNotify } from './ru/holidays-notify.ts';
import { ruInvitations } from './ru/invitations.ts';
import { ruOnboarding } from './ru/onboarding.ts';
import { ruSettings } from './ru/settings.ts';
import { ruSharingVoice } from './ru/sharing-voice.ts';
import { ruSpeechSyncStats } from './ru/speech-sync-stats.ts';
import { ruTips } from './ru/tips.ts';
import { ruWorkflow } from './ru/workflow.ts';

export const MSG = {
  en: {
    ...enWorkflow,
    ...enOnboarding,
    ...enAgentStatus,
    ...enAddWizard,
    ...enHolidaysNotify,
    ...enGcal,
    ...enInvitations,
    ...enSharingVoice,
    ...enSettings,
    ...enAiTools,
    ...enConnectTelegram,
    ...enCallbackErrors,
    ...enFormatting,
    ...enTips,
    ...enSpeechSyncStats,
  },
  ru: {
    ...ruWorkflow,
    ...ruOnboarding,
    ...ruAgentStatus,
    ...ruAddWizard,
    ...ruHolidaysNotify,
    ...ruGcal,
    ...ruInvitations,
    ...ruSharingVoice,
    ...ruSettings,
    ...ruAiTools,
    ...ruConnectTelegram,
    ...ruCallbackErrors,
    ...ruFormatting,
    ...ruTips,
    ...ruSpeechSyncStats,
  },
} as const;

export type Lang = keyof typeof MSG;
export type Messages = (typeof MSG)[Lang];

/** Validate a string to Lang, defaulting to 'en' for unknown values. Matches the primary subtag of
 *  an IETF language tag, so 'ru-RU' / 'ru-BY' resolve to 'ru' rather than the default. */
export function toLang(value: string | null | undefined): Lang {
  const primary = value?.split('-')[0]?.toLowerCase();
  if (primary === 'ru' || primary === 'en') return primary;
  return 'en';
}

export function t(lang: Lang): Messages {
  return MSG[lang] || MSG.en;
}

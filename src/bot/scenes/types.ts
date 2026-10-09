// src/bot/scenes/types.ts — Scene state interfaces shared across scenes, handlers, and services.

export interface AddEventParams {
  title?: string;
  pendingDate?: string;
  startAt?: string;
  timezone?: string;
  groupId?: number;
}

export interface AddEventState {
  promptMessageId?: number;
  createdEventId?: number;
  timezone?: string;
  groupId?: number;
  title?: string;
  startAt?: string;
  pendingDate?: string;
  endAt?: string;
  allDay?: boolean;
  recurrenceRule?: string | null;
  recEndMode?: 'until' | 'count';
  description?: string;
  location?: string;
}

export interface OnboardingParams {
  pendingInvitationId?: number;
  pendingEventId?: number;
  pendingInviterTelegramId?: number;
}

export interface OnboardingState {
  lang?: 'en' | 'ru';
  detectedTz?: string;
  timezone?: string;
  country?: string;
}

export interface TimezoneState {
  detectedTz?: string;
  cityInputMode?: boolean;
  geoMsgId?: number;
}

export interface SceneKvStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | undefined>;
}

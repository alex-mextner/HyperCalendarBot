// src/bot/scenes/types.ts — Scene state interfaces shared across scenes, handlers, and services.

export interface AddEventState {
  title?: string;
  startAt?: string;
  endAt?: string;
  recurrenceRule?: string | null;
  recEndMode?: 'until' | 'count';
  description?: string;
  location?: string;
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

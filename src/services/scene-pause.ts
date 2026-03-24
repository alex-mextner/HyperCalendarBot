// src/services/scene-pause.ts
import { z } from 'zod';
import type { AddEventState } from '../bot/scenes/add-event.scene.ts';
import type { OnboardingState } from '../bot/scenes/onboarding.scene.ts';
import type { TimezoneState } from '../bot/scenes/timezone.scene.ts';

/** Discriminated union of all wizard scene pause states. When adding a new scene, extend this union. */
export type ScenePauseState =
  | { sceneName: 'add_event'; step: number; sceneState: AddEventState }
  | { sceneName: 'timezone'; step: number; sceneState: TimezoneState }
  | { sceneName: 'onboarding'; step: number; sceneState: OnboardingState }
  | { sceneName: 'edit_value'; step: number; sceneState: Record<never, never> }
  | { sceneName: 'import'; step: number; sceneState: Record<never, never> };

export type SceneName = ScenePauseState['sceneName'];

const AddEventStateSchema = z.object({
  title: z.string().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  recurrenceRule: z.string().nullable().optional(),
  recEndMode: z.enum(['until', 'count']).optional(),
  description: z.string().optional(),
  location: z.string().optional(),
});

const TimezoneStateSchema = z.object({
  detectedTz: z.string().optional(),
  cityInputMode: z.boolean().optional(),
  geoMsgId: z.number().optional(),
});

const OnboardingStateSchema = z.object({
  lang: z.enum(['en', 'ru']).optional(),
  detectedTz: z.string().optional(),
  timezone: z.string().optional(),
  country: z.string().optional(),
});

const EmptyStateSchema = z.object({});

const ScenePauseSchema = z.discriminatedUnion('sceneName', [
  z.object({ sceneName: z.literal('add_event'), step: z.number(), sceneState: AddEventStateSchema }),
  z.object({ sceneName: z.literal('timezone'), step: z.number(), sceneState: TimezoneStateSchema }),
  z.object({ sceneName: z.literal('onboarding'), step: z.number(), sceneState: OnboardingStateSchema }),
  z.object({ sceneName: z.literal('edit_value'), step: z.number(), sceneState: EmptyStateSchema }),
  z.object({ sceneName: z.literal('import'), step: z.number(), sceneState: EmptyStateSchema }),
]);

type KvStorage = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | undefined>;
};

const pauseKey = (userId: number) => `scene-pause:${userId}`;

export class ScenePauseService {
  constructor(private storage: KvStorage) {}

  async save(userId: number, state: ScenePauseState): Promise<void> {
    await this.storage.set(pauseKey(userId), JSON.stringify(state));
  }

  async get(userId: number): Promise<ScenePauseState | null> {
    const raw = await this.storage.get(pauseKey(userId));
    if (!raw) return null;
    try {
      const json: unknown = JSON.parse(raw as string);
      const result = ScenePauseSchema.safeParse(json);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  async clear(userId: number): Promise<void> {
    await this.storage.delete(pauseKey(userId));
  }
}

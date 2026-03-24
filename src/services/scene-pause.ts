// src/services/scene-pause.ts
import { z } from 'zod';

export interface ScenePauseState {
  sceneName: string;
  step: number;
  sceneState: Record<string, unknown>;
}

type KvStorage = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw as string);
    } catch {
      return null;
    }
    const result = z
      .object({ sceneName: z.string(), step: z.number(), sceneState: z.record(z.string(), z.unknown()) })
      .safeParse(parsed);
    return result.success ? result.data : null;
  }

  async clear(userId: number): Promise<void> {
    await this.storage.delete(pauseKey(userId));
  }
}

// src/services/scene-pause.ts
import type { JsonObject } from '../utils/types.ts';

export interface ScenePauseState {
  sceneName: string;
  step: number;
  sceneState: JsonObject;
}

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
      return JSON.parse(raw as string) as ScenePauseState;
    } catch {
      return null;
    }
  }

  async clear(userId: number): Promise<void> {
    await this.storage.delete(pauseKey(userId));
  }
}

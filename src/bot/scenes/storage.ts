// src/bot/scenes/storage.ts
import type { Database } from 'bun:sqlite';
import { sqliteStorage } from '@gramio/storage-sqlite';

export interface SceneKvStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | undefined>;
}

export function createSceneStorage(db: Database) {
  return sqliteStorage({
    db,
    tableName: 'gramio_scenes',
    $ttl: 30 * 60, // 30 min TTL (in seconds) for scene data
  });
}

const PREFIX = 'ai:routing-repair:';
const DEFAULT_TTL_SECONDS = 15 * 60;

export interface RoutingRepairStore {
  isOpen(chatId: number, userId: number): Promise<boolean>;
  open(chatId: number, userId: number): Promise<void>;
  clear(chatId: number, userId: number): Promise<void>;
}

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
}
function key(chatId: number, userId: number): string {
  return `${PREFIX}${chatId}:${userId}`;
}
export class RedisRoutingRepairStore implements RoutingRepairStore {
  constructor(
    private redis: RedisLike,
    private ttlSeconds = DEFAULT_TTL_SECONDS,
  ) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 24 * 60 * 60)
      throw new Error('INVALID_REPAIR_TTL');
  }
  async isOpen(chatId: number, userId: number): Promise<boolean> {
    return (await this.redis.get(key(chatId, userId))) === '1';
  }
  async open(chatId: number, userId: number): Promise<void> {
    await this.redis.set(key(chatId, userId), '1', 'EX', this.ttlSeconds);
  }
  async clear(chatId: number, userId: number): Promise<void> {
    await this.redis.del(key(chatId, userId));
  }
}
export class InMemoryRoutingRepairStore implements RoutingRepairStore {
  private values = new Map<string, number>();
  constructor(private ttlMs = DEFAULT_TTL_SECONDS * 1000) {}
  async isOpen(chatId: number, userId: number): Promise<boolean> {
    const k = key(chatId, userId),
      until = this.values.get(k) ?? 0;
    if (until <= Date.now()) {
      this.values.delete(k);
      return false;
    }
    return true;
  }
  async open(chatId: number, userId: number): Promise<void> {
    this.values.set(key(chatId, userId), Date.now() + this.ttlMs);
  }
  async clear(chatId: number, userId: number): Promise<void> {
    this.values.delete(key(chatId, userId));
  }
}

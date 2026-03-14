import { randomBytes } from 'node:crypto';

export interface ShareSession {
  userId: number;
  targetType: 'user' | 'group';
  targetId: number;
  contentType: 'agenda' | 'event';
  period?: 'today' | 'tomorrow' | 'week';
  eventId?: number;
}

const SESSION_TTL = 300; // 5 minutes
const KEY_PREFIX = 'share_session:';

export class ShareSessionManager {
  constructor(
    private redis: {
      set: (key: string, value: string, options?: { ex?: number }) => Promise<string>;
      get: (key: string) => Promise<string | null>;
      del: (key: string) => Promise<number>;
    },
  ) {}

  async create(data: ShareSession): Promise<string> {
    const id = `sess_${randomBytes(8).toString('base64url')}`;
    await this.redis.set(`${KEY_PREFIX}${id}`, JSON.stringify(data), { ex: SESSION_TTL });
    return id;
  }

  async resolve(id: string): Promise<ShareSession | null> {
    const raw = await this.redis.get(`${KEY_PREFIX}${id}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async consume(id: string): Promise<ShareSession | null> {
    const session = await this.resolve(id);
    if (session) await this.redis.del(`${KEY_PREFIX}${id}`);
    return session;
  }
}

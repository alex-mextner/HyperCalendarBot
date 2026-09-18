/** Request-scoped, bounded metadata inspection. Callers must check permission on every use. */
import type { AgentContext } from './types.ts';

type Profile = NonNullable<Awaited<ReturnType<NonNullable<AgentContext['lookupTelegramUser']>>>> & {
  checkedAt: string;
};
type Inspection = { expiresAt: number; pending: Promise<Profile | null> };
const inspections = new WeakMap<AgentContext, Map<string, Inspection>>();
const TTL = 30_000;
const MAX_INSPECTIONS = 32;

export function inspectRecipientProfile(ctx: AgentContext, id: number): Promise<Profile | null> {
  if (!ctx.lookupTelegramUser) return Promise.resolve(null);
  let cache = inspections.get(ctx);
  if (!cache) {
    cache = new Map();
    inspections.set(ctx, cache);
  }
  const now = Date.now();
  for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key);
  const key = `${ctx.user.telegram_id}:${id}`;
  const existing = cache.get(key);
  if (existing) return existing.pending;
  if (cache.size >= MAX_INSPECTIONS) return Promise.resolve(null);
  const lookup = ctx.lookupTelegramUser;
  const pending = new Promise<Profile | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), 20_000);
    timeout.unref();
    Promise.resolve()
      .then(() => lookup(id))
      .then(
        (profile) => resolve(profile ? { ...profile, checkedAt: new Date().toISOString() } : null),
        () => resolve(null),
      )
      .finally(() => clearTimeout(timeout));
  });
  cache.set(key, { expiresAt: now + TTL, pending });
  return pending;
}

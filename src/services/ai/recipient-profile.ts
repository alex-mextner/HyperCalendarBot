/** Request-scoped recipient metadata. Exact username resolutions retain their verified profile for
 *  ID-based sends; optional direct-ID inspections use the configured service account. Callers must
 *  still check recipient permission on every use. */
import { reportTimeout } from '../incident/timeout-reporter.ts';
import type { TelegramProfile } from '../telegram-session/service-tier.ts';
import type { AgentContext } from './types.ts';

type Profile = TelegramProfile & { checkedAt: string };
type RememberedProfile = { profile: Profile; source: 'inspection' | 'username' };
type Inspection = { expiresAt: number; pending: Promise<Profile | null>; result?: Profile | null };
const inspections = new WeakMap<AgentContext, Map<string, Inspection>>();
const TTL = 30_000;
const MAX_INSPECTIONS = 8;
const resolvedProfiles = new WeakMap<AgentContext, Map<string, RememberedProfile>>();
const MAX_RESOLVED_PROFILES = 32;

function rememberProfile(ctx: AgentContext, profile: Profile, source: RememberedProfile['source']): void {
  let cache = resolvedProfiles.get(ctx);
  if (!cache) {
    cache = new Map();
    resolvedProfiles.set(ctx, cache);
  }
  const key = `${ctx.user.telegram_id}:${profile.id}`;
  cache.set(key, { profile: { ...profile }, source });
  if (cache.size > MAX_RESOLVED_PROFILES) cache.delete(cache.keys().next().value!);
}

/** Inspection evidence remains authoritative even if its profile hint was evicted. */
function retainedInspection(ctx: AgentContext, key: string): Profile | null {
  const entry = inspections.get(ctx)?.get(key);
  if (entry && entry.expiresAt > Date.now() && entry.result) return entry.result;
  const remembered = resolvedProfiles.get(ctx)?.get(key);
  return remembered?.source === 'inspection' ? remembered.profile : null;
}

/** Keep a verified username hint for this turn; the send path still pins the numeric recipient ID. */
export function rememberResolvedRecipient(
  ctx: AgentContext,
  profile: TelegramProfile,
  source: 'personal' | 'service',
): void {
  const key = `${ctx.user.telegram_id}:${profile.id}`;
  if (source === 'service') {
    // Service username responses can come from a ten-minute cache. Keep direct inspection
    // evidence, including the last completed result while another inspection is pending.
    if (retainedInspection(ctx, key)) return;
  } else {
    // A fresh personal resolution supersedes an older inspection, including one still in flight.
    inspections.get(ctx)?.delete(key);
  }
  rememberProfile(ctx, { ...profile, checkedAt: new Date().toISOString() }, 'username');
}

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
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      // Callers fall back to saved metadata, so the user still gets an answer.
      reportTimeout({
        kind: 'recipient_profile',
        elapsedMs: Date.now() - startedAt,
        limitMs: 20_000,
        recovered: true,
      });
      resolve(null);
    }, 20_000);
    timeout.unref();
    Promise.resolve()
      .then(() => lookup(id))
      .then(
        (profile) => resolve(profile ? { ...profile, checkedAt: new Date().toISOString() } : null),
        () => resolve(null),
      )
      .finally(() => clearTimeout(timeout));
  });
  const entry: Inspection = { expiresAt: now + TTL, pending };
  pending.then((result) => {
    entry.result = result;
    // Do not let a superseded query overwrite a later username resolution.
    if (result && result.id === id && inspections.get(ctx)?.get(key) === entry)
      rememberProfile(ctx, result, 'inspection');
  });
  cache.set(key, entry);
  return pending;
}

/** Read only a completed, caller-scoped inspection; never start optional I/O during delivery. */
export function cachedRecipientProfile(ctx: AgentContext, id: number): Profile | null {
  const key = `${ctx.user.telegram_id}:${id}`;
  return retainedInspection(ctx, key) ?? resolvedProfiles.get(ctx)?.get(key)?.profile ?? null;
}

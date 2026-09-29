// src/bot/commands/add-v3.ts
//
// GH-652's full-field /add path: when `DIALOGUE_V3_ENABLED` is on, a fully specified command
// (title + time/all-day, optionally people + place) creates the event in one turn with zero
// LLM calls, reading the shared `event.create` registration (src/services/operations/
// registry.ts) instead of a third bespoke parser. An incomplete command with no explicit
// people/place obligation at stake still falls through to the existing, unmodified
// add-event.scene.ts wizard (see add.ts) — but once ANY people/place obligation was explicitly
// resolved this turn (an exact person, a place, a fuzzy/unresolved name awaiting confirmation),
// the legacy wizard's `AddEventParams` has no field to carry it, so falling through would
// silently drop it. Per the 2026-09-28 parent review ("do not fall back to legacy wizard after
// resolving people/place ... if fallback drops them"), that case instead persists a real v3
// dialogue session (the SAME store/continuation logic the natural-text layer uses,
// session-runtime.ts's `advance`) and asks whatever is still missing — the draft is never
// dropped, and it is never handed to a code path that cannot represent it.
//
// Reuses, never reimplements: `session-runtime.ts`'s `advance`/`executeDraft` (event creation,
// real invitation delivery, the Google-push/place-verification hooks, the receipt card — shared
// verbatim with the natural-text entry adapter, dialogue-v3-layer.ts).

import type { User } from '../../database/types.ts';
import { parseFullField } from '../../services/dialogue/full-field-parser.ts';
import type { PeopleResolver, PlaceResolver } from '../../services/dialogue/resolvers.ts';
import {
  advance,
  applyParseResultToDraft,
  emptyDraft,
  reconcileBeforeNewTurn,
  type SessionRuntimeDeps,
  type SessionShell,
  toPendingConfirmations,
} from '../../services/dialogue/session-runtime.ts';
import { getOperation } from '../../services/operations/registry.ts';
import type { BotCommandContext } from '../types.ts';

export interface DialogueV3AddDeps extends SessionRuntimeDeps {
  readonly enabled: boolean;
  readonly peopleResolver: PeopleResolver;
  readonly placeResolver: PlaceResolver;
  /** Injected for determinism in tests; defaults to `new Date()`. */
  readonly now?: () => Date;
}

/**
 * `handled: true` means this module already produced the whole user-visible result (created
 * the event, or persisted a v3 draft and asked the next question) — the caller MUST return
 * without entering the legacy wizard. `handled: false` means nothing explicit was resolved
 * (no people/place obligation at stake), and the caller should proceed with its existing
 * flow; `seed` carries whatever this pass DID resolve — a strict improvement over the legacy
 * suffix scan, since it reads the GH-650-fixed shared parser — so the wizard doesn't re-ask
 * for a title/time answer the full-field parser already found.
 */
export type FullFieldAddOutcome =
  | { readonly handled: true }
  | { readonly handled: false; readonly seed: { readonly title?: string; readonly startAt?: string } };

export async function tryFullFieldAdd(
  ctx: BotCommandContext,
  user: User,
  timezone: string,
  groupId: number | null,
  input: string,
  deps: DialogueV3AddDeps,
): Promise<FullFieldAddOutcome> {
  if (!deps.enabled) return { handled: false, seed: {} };
  // Defensive: the registry is registered at module load; a missing registration means this
  // slice's own setup is broken, not a reason to guess at fields — abstain to the legacy path.
  if (!getOperation('event.create')) return { handled: false, seed: {} };

  const now = deps.now ? deps.now() : new Date();
  const parseResult = parseFullField(input, {
    timezone,
    now,
    actorId: user.telegram_id,
    peopleResolver: deps.peopleResolver,
    placeResolver: deps.placeResolver,
  });

  const scope: 'personal' | 'group' = groupId !== null ? 'group' : 'personal';
  const draft = applyParseResultToDraft(
    emptyDraft(scope, groupId !== null ? groupId : undefined),
    parseResult.patch,
    user.default_event_duration_minutes ?? 60,
  );

  const explicitObligationAtStake =
    draft.people.length > 0 ||
    Boolean(draft.place) ||
    parseResult.fuzzyPeople.length > 0 ||
    parseResult.unresolvedPeopleNames.length > 0;

  const seed = {
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.schedule?.kind === 'timed' ? { startAt: draft.schedule.startAt } : {}),
  };

  if (!parseResult.negated && !explicitObligationAtStake && (!draft.title || !draft.schedule)) {
    // Nothing the legacy wizard would drop is at stake, and this isn't a negated request that
    // must never reach the wizard at all — same seeded-fallback behavior as before this slice.
    return { handled: false, seed };
  }

  const key = { chatId: Number(ctx.chatId ?? user.telegram_id), userId: user.telegram_id, topicId: 0 };
  // Opportunistic crash recovery: an `executed` session with unresolved durable effects
  // (session-runtime.ts's `EffectLedger`) is the only record of what happened after the event
  // already exists — reconciled here (or found to already be fully reconciled) before this
  // insert-only write below. A still-`blocked` result means the ledger could not be fully
  // reconciled just now (e.g. an effect is durably `unknown`/`failed` from a prior crash) —
  // that is a fully-created event with unresolved follow-up actions, never an "in-progress
  // draft", so it gets its own accurate message instead of falling into the race_lost branch
  // below (which would otherwise claim there is an unanswered question).
  const reconciliation = await reconcileBeforeNewTurn(ctx, user, key, deps);
  if (reconciliation.blocked) {
    await ctx.send(
      ctx.lang === 'ru'
        ? 'Предыдущее событие уже создано, но не все действия после этого подтверждены (приглашения, синхронизация, квитанция) — подожди подтверждения перед новым запросом.'
        : 'The previous event was already created, but some follow-up actions (invitations, calendar sync, receipt) are not yet confirmed — please wait before starting a new request.',
    );
    return { handled: true };
  }
  const shell: SessionShell = {
    version: 3,
    sessionId: crypto.randomUUID(),
    actorId: user.telegram_id,
    chatId: key.chatId,
    topicId: key.topicId,
    operation: 'event.create',
    timezone,
    createdAt: now.getTime(),
    sourceText: input,
  };
  const outcome = await advance(
    ctx,
    user,
    timezone,
    key,
    shell,
    draft,
    parseResult.selectedDate,
    toPendingConfirmations(parseResult.fuzzyPeople, parseResult.unresolvedPeopleNames),
    parseResult.negated,
    /* expectedRevision: */ null,
    deps,
  );
  if (outcome.kind === 'race_lost') {
    // An active v3 session already owns this actor+chat+topic (e.g. two /add commands sent
    // back to back before the first resolved) — never silently overwrite it; fall through to
    // the seeded legacy wizard is wrong too (it would drop the SAME obligations this branch
    // exists to protect), so this abstains with an explicit notice instead.
    await ctx.send(
      ctx.lang === 'ru'
        ? 'У тебя уже есть незавершённый черновик события — сначала ответь на предыдущий вопрос.'
        : 'You already have an in-progress event draft — please answer the previous question first.',
    );
    return { handled: true };
  }
  return { handled: true };
}

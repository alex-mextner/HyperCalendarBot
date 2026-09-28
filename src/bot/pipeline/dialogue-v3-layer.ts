// src/bot/pipeline/dialogue-v3-layer.ts
//
// GH-652's natural-text entry adapter: the SAME operation registry, full-field parser and
// session-runtime engine `/add` uses (add-v3.ts), driven from plain chat text instead of a
// slash command. Placed after IntentMatcherLayer (an approved custom intent still wins) and
// before AiAgentLayer (message.handler.ts), so returning `{ handled: false }` — a starter
// phrase this closed grammar doesn't recognize, or a continuation turn that resolved nothing —
// falls through to the existing AI agent exactly once, per the design brief's "unmatched
// complex input hands off to the existing AI path ONCE; local invalid/ambiguity does not
// invoke LLM." The layer object is always constructed when `deps.dialogueV3` is wired (see
// bot/index.ts); the actual gate is `deps.enabled` (DIALOGUE_V3_ENABLED) — checked first thing
// below, so a disabled flag is a true no-op regardless of construction.
//
// One-active-interaction-owner invariant (parent review, "v3 and legacy workflow/scene must
// not both consume the same reply"): message.handler.ts's own `layers` array places
// `intentLayer` BEFORE this layer, and `intentLayer` unconditionally resumes and consumes the
// turn whenever `workflowSessions` (the v1/v2 regex-intent session store) has an active session
// for this chat+user — this layer function is therefore structurally unreachable while one is
// active. The GramIO scene wizard wins even earlier: `.extend(scenesSetup.plugin)` in
// bot/index.ts intercepts the update before message.handler.ts's pipeline runs at all while a
// scene is active. `deps.workflowSessions` below is a defensive second check (real protection
// for any caller that wires this layer standalone, e.g. a future reordering or a test), not the
// primary guarantee.

import { t } from '../../config/constants.ts';
import type {
  DialogueSessionKey,
  DialogueSessionRepository,
} from '../../database/repositories/dialogue-session.repository.ts';
import type { User } from '../../database/types.ts';
import { parseFullField } from '../../services/dialogue/full-field-parser.ts';
import type { PeopleResolver, PlaceResolver } from '../../services/dialogue/resolvers.ts';
import {
  advance,
  applyParseResultToDraft,
  emptyDraft,
  type SessionRuntimeDeps,
  type SessionShell,
  toPendingConfirmations,
} from '../../services/dialogue/session-runtime.ts';
import type { DialogueV3Session, EventCreateDraft, PendingFuzzyPerson } from '../../services/dialogue/v3-types.ts';
import type { BotCommandContext } from '../types.ts';
import type { GroupContext, PipelineResult, WorkflowSessionStore } from './types.ts';

export interface DialogueV3LayerDeps extends SessionRuntimeDeps {
  readonly enabled: boolean;
  readonly dialogueSessions: DialogueSessionRepository;
  readonly peopleResolver: PeopleResolver;
  readonly placeResolver: PlaceResolver;
  readonly now?: () => Date;
  /** See this file's header comment — a defensive second check, not the primary guarantee. */
  readonly workflowSessions?: WorkflowSessionStore;
}

// Closed starter-verb lexicon, RU+EN — a leading trigger word is what decides "this message
// starts an event.create draft", never a network classifier (design: "Laya ... remains
// optional/unqualified; do not add mandatory network classification").
const STARTER_VERBS: Readonly<Record<string, true>> = {
  сделай: true,
  создай: true,
  запланируй: true,
  добавь: true,
  schedule: true,
  add: true,
  create: true,
};

const CANCEL_WORDS: Readonly<Record<string, true>> = { cancel: true, отмена: true, отменить: true };
const YES_WORDS: Readonly<Record<string, true>> = { yes: true, y: true, да: true, ага: true };
const NO_WORDS: Readonly<Record<string, true>> = { no: true, n: true, нет: true };
const SKIP_WORDS: Readonly<Record<string, true>> = { skip: true, пропустить: true };

function firstWord(text: string): string {
  return text.trim().toLowerCase().split(/\s+/)[0] ?? '';
}

/** Group-scoped when the pipeline reports a group chat; personal otherwise — never hardcoded. */
function draftScope(extra: { groupContext?: GroupContext } | undefined): {
  scope: 'personal' | 'group';
  groupId?: number;
} {
  return extra?.groupContext?.isGroup && extra.groupContext.groupChatId !== undefined
    ? { scope: 'group', groupId: extra.groupContext.groupChatId }
    : { scope: 'personal' };
}

function shellFor(
  user: User,
  key: DialogueSessionKey,
  timezone: string,
  sourceText: string,
  now: number,
): SessionShell {
  return {
    version: 3,
    sessionId: crypto.randomUUID(),
    actorId: user.telegram_id,
    chatId: key.chatId,
    topicId: key.topicId,
    operation: 'event.create',
    timezone,
    createdAt: now,
    sourceText,
  };
}

function shellFromExisting(existing: DialogueV3Session): SessionShell {
  return {
    version: 3,
    sessionId: existing.sessionId,
    actorId: existing.actorId,
    chatId: existing.chatId,
    topicId: existing.topicId,
    operation: existing.operation,
    timezone: existing.timezone,
    createdAt: existing.createdAt,
    sourceText: existing.sourceText,
  };
}

/**
 * Resolves one pending name confirmation (a real fuzzy match OR a zero-candidate unresolved
 * name — see v3-types.ts's DialogueV3Session.pendingFuzzyPeople doc). A real candidate is only
 * ever added on an explicit "yes"; a zero-candidate entry has nothing to confirm, so yes/no/skip
 * all just move past it (drop that name) — an unrecognized reply re-asks locally, never a
 * reason to hand off to the AI path.
 */
async function continueFuzzyConfirmation(
  ctx: BotCommandContext,
  user: User,
  existing: DialogueV3Session,
  messageText: string,
  key: DialogueSessionKey,
  timezone: string,
  deps: DialogueV3LayerDeps,
): Promise<PipelineResult> {
  const [pending, ...rest] = existing.pendingFuzzyPeople;
  if (!pending) {
    await advance(
      ctx,
      user,
      timezone,
      key,
      shellFromExisting(existing),
      existing.draft,
      existing.selectedDate,
      [],
      false,
      existing.revision,
      deps,
    );
    return { handled: true };
  }

  const answer = messageText.trim().toLowerCase();
  const hasCandidate = pending.candidates.length > 0;
  let draft: EventCreateDraft = existing.draft;
  if (hasCandidate && YES_WORDS[answer]) {
    const candidate = pending.candidates[0]!;
    draft = {
      ...existing.draft,
      people: [
        ...existing.draft.people,
        {
          contactId: candidate.contactId,
          telegramId: candidate.telegramId,
          displayName: candidate.displayName,
          confirmed: true,
        },
      ],
    };
  } else if (!(NO_WORDS[answer] || SKIP_WORDS[answer] || (!hasCandidate && YES_WORDS[answer]))) {
    // Local ambiguity on a KNOWN field stays local — never a reason to hand off to the AI path.
    await sendPendingQuestion(ctx, pending);
    return { handled: true };
  }
  await advance(
    ctx,
    user,
    timezone,
    key,
    shellFromExisting(existing),
    draft,
    existing.selectedDate,
    rest,
    false,
    existing.revision,
    deps,
  );
  return { handled: true };
}

async function sendPendingQuestion(ctx: BotCommandContext, pending: PendingFuzzyPerson): Promise<void> {
  if (pending.candidates.length === 0) {
    await ctx.send(
      ctx.lang === 'ru'
        ? `Не нашёл контакт «${pending.rawName}» — пришли точное имя, которое я знаю, или ответь "skip", чтобы продолжить без него.`
        : `I don't have a contact named "${pending.rawName}" — send a name I know, or reply "skip" to continue without them.`,
    );
    return;
  }
  const candidate = pending.candidates[0];
  const name = candidate?.displayName ?? pending.rawName;
  await ctx.send(
    ctx.lang === 'ru'
      ? `Ты имел в виду ${name} (для "${pending.rawName}")? Ответь да/нет.`
      : `Did you mean ${name} for "${pending.rawName}"? Reply yes/no.`,
  );
}

export function createDialogueV3Layer(deps: DialogueV3LayerDeps) {
  return async (
    ctx: BotCommandContext,
    messageText: string,
    extra?: { groupContext?: GroupContext },
  ): Promise<PipelineResult> => {
    if (!deps.enabled) return { handled: false };
    const user = ctx.dbUser;
    if (!user) return { handled: false };
    const key: DialogueSessionKey = {
      chatId: Number(ctx.chatId ?? user.telegram_id),
      userId: user.telegram_id,
      topicId: extra?.groupContext?.topicThreadId ?? 0,
    };
    // See this file's header comment — defensive second check; intentLayer already prevents
    // reaching here in the real composed pipeline whenever this is non-null.
    if (deps.workflowSessions?.get(key.chatId, user.telegram_id)) return { handled: false };

    const timezone = user.timezone;
    const now = deps.now ? deps.now() : new Date();

    const existing = deps.dialogueSessions.get(key);
    if (existing && existing.status === 'collecting') {
      if (CANCEL_WORDS[messageText.trim().toLowerCase()]) {
        deps.dialogueSessions.delete(key);
        await ctx.send(t(ctx.lang).cancelled);
        return { handled: true };
      }

      if (existing.pendingField === 'people' && existing.pendingFuzzyPeople.length > 0) {
        return continueFuzzyConfirmation(ctx, user, existing, messageText, key, timezone, deps);
      }

      const parseResult = parseFullField(messageText, {
        timezone,
        now,
        actorId: user.telegram_id,
        peopleResolver: deps.peopleResolver,
        placeResolver: deps.placeResolver,
        anchorDate: existing.selectedDate,
      });
      if (parseResult.negated) {
        await advance(
          ctx,
          user,
          timezone,
          key,
          shellFromExisting(existing),
          existing.draft,
          existing.selectedDate,
          [],
          true,
          existing.revision,
          deps,
        );
        return { handled: true };
      }
      // A turn only counts as progress when it actually addresses the field we're waiting on
      // (or resolves people/place, which are never pending but still welcome) — a bare leftover
      // title-shaped string (parseFullField always fills `patch.title` from whatever it didn't
      // recognize) must NOT count as "answered the time question" just because text exists.
      const addressedPendingField =
        existing.pendingField === 'schedule'
          ? parseResult.timeResolution !== null
          : existing.pendingField === 'title'
            ? Boolean(parseResult.patch.title)
            : true;
      const resolvedSomething =
        addressedPendingField ||
        Boolean(parseResult.patch.people?.length) ||
        Boolean(parseResult.patch.place) ||
        parseResult.fuzzyPeople.length > 0 ||
        parseResult.unresolvedPeopleNames.length > 0;
      if (!resolvedSomething) {
        // This turn's answer doesn't fit the closed grammar for what we're waiting on — hand off
        // to the existing AI path exactly once (return handled:false, AiAgentLayer is the next
        // layer). The typed payload for that handoff (buildAiHandoffPayload, ai-handoff.ts) is
        // built and passed to AgentContextBuilder by GH-656's own wiring, not duplicated here.
        deps.dialogueSessions.set(key, { ...existing, status: 'handed_off', updatedAt: Date.now() }, existing.revision);
        return { handled: false };
      }
      const draft = applyParseResultToDraft(
        existing.draft,
        parseResult.patch,
        user.default_event_duration_minutes ?? 60,
      );
      await advance(
        ctx,
        user,
        timezone,
        key,
        shellFromExisting(existing),
        draft,
        parseResult.selectedDate,
        toPendingConfirmations(parseResult.fuzzyPeople, parseResult.unresolvedPeopleNames),
        false,
        existing.revision,
        deps,
      );
      return { handled: true };
    }

    if (firstWord(messageText) === '' || !STARTER_VERBS[firstWord(messageText)]) return { handled: false };

    const parseResult = parseFullField(messageText, {
      timezone,
      now,
      actorId: user.telegram_id,
      peopleResolver: deps.peopleResolver,
      placeResolver: deps.placeResolver,
    });
    const { scope, groupId } = draftScope(extra);
    const draft = applyParseResultToDraft(
      emptyDraft(scope, groupId),
      parseResult.patch,
      user.default_event_duration_minutes ?? 60,
    );
    const shell = shellFor(user, key, timezone, messageText, now.getTime());
    // A brand-new starter turn CAS-overwrites whatever row (if any) is currently there — a
    // legitimately abandoned/handed-off/stuck-executing draft must not permanently block a new
    // request, but the overwrite itself is still race-checked against the row's CURRENT
    // revision, never a blind unconditional upsert.
    await advance(
      ctx,
      user,
      timezone,
      key,
      shell,
      draft,
      parseResult.selectedDate,
      toPendingConfirmations(parseResult.fuzzyPeople, parseResult.unresolvedPeopleNames),
      parseResult.negated,
      existing ? existing.revision : null,
      deps,
    );
    return { handled: true };
  };
}

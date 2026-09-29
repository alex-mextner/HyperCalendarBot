// src/services/dialogue/ai-handoff.ts
//
// The typed payload the v3 dialogue runtime hands to the existing AI agent path exactly ONCE
// when local (deterministic) parsing genuinely cannot continue — e.g. the pending question's
// answer didn't match the expected shape, or the follow-up turn is complex free text the
// closed grammar in full-field-parser.ts doesn't cover. A LOCAL invalid/ambiguous result on a
// KNOWN field (bare-hour ambiguity, a fuzzy-person confirmation, a malformed date) is NEVER a
// reason to build this payload — those stay local (design brief: "local invalid/ambiguity
// does not invoke LLM"). This module only builds the payload; wiring it into
// AiAgentLayer/AgentContextBuilder so the AI model actually receives it as extra context is
// GH-656's explicit scope (its GH-554 plan entry: "shadow NLU adapter, blocked by #652") — see
// this repo's docs/superpowers/plans/2026-09-28-unified-dialogue-implementation-plan.md.

import type { DialogueV3Session } from './v3-types.ts';

export interface AiHandoffPayload {
  /** The exact text that could not be locally parsed, preserved verbatim — never summarized. */
  readonly originalText: string;
  /** What the runtime was still waiting on when the handoff happened, if anything. */
  readonly pendingQuestion: string | null;
  /** The in-progress draft at the moment of handoff, so the AI model builds on it, not a blank slate. */
  readonly draft: DialogueV3Session['draft'];
  readonly scope: 'personal' | 'group';
  /** The session's anchor — a stale/foreign reply to a later revision must not resolve against this handoff. */
  readonly anchor: string;
  /**
   * Evidence this handoff already carries so the AI path never re-does work or fabricates
   * having done it (design brief: "significant unconsumed text/negation can't be dropped").
   */
  readonly receipts: {
    readonly negated: boolean;
    readonly unresolvedPeopleNames: readonly string[];
  };
}

export interface HandoffInput {
  readonly session: DialogueV3Session;
  readonly rawText: string;
  readonly negated: boolean;
  readonly unresolvedPeopleNames: readonly string[];
}

/** Builds the handoff payload from a session that could not continue locally; never mutates the session. */
export function buildAiHandoffPayload(input: HandoffInput): AiHandoffPayload {
  return {
    originalText: input.rawText,
    pendingQuestion: input.session.pendingField,
    draft: input.session.draft,
    scope: input.session.draft.scope,
    anchor: input.session.sessionId,
    receipts: {
      negated: input.negated,
      unresolvedPeopleNames: input.unresolvedPeopleNames,
    },
  };
}

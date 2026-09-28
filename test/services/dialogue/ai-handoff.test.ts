// test/services/dialogue/ai-handoff.test.ts
import { describe, expect, test } from 'bun:test';
import { buildAiHandoffPayload } from '../../../src/services/dialogue/ai-handoff.ts';
import { type DialogueV3Session, emptyDraft } from '../../../src/services/dialogue/v3-types.ts';

function makeSession(overrides: Partial<DialogueV3Session> = {}): DialogueV3Session {
  const now = Date.now();
  return {
    version: 3,
    sessionId: 'anchor-abc',
    actorId: 1,
    chatId: 100,
    topicId: 0,
    operation: 'event.create',
    draft: { ...emptyDraft('personal'), title: 'Meeting' },
    pendingField: 'schedule',
    status: 'collecting',
    createdAt: now,
    updatedAt: now,
    sourceText: 'Meeting tomorrow',
    ...overrides,
  };
}

describe('buildAiHandoffPayload — the exact contract handed to the AI path once', () => {
  test('carries original text, pending question, draft, scope, anchor and receipts', () => {
    const session = makeSession();
    const payload = buildAiHandoffPayload({
      session,
      rawText: 'sometime next week I guess, ask Kristin too',
      negated: false,
      unresolvedPeopleNames: ['Zorblax'],
    });
    expect(payload).toEqual({
      originalText: 'sometime next week I guess, ask Kristin too',
      pendingQuestion: 'schedule',
      draft: session.draft,
      scope: 'personal',
      anchor: 'anchor-abc',
      receipts: { negated: false, unresolvedPeopleNames: ['Zorblax'] },
    });
  });

  test('never mutates the session it reads from', () => {
    const session = makeSession();
    const snapshot = JSON.stringify(session);
    buildAiHandoffPayload({ session, rawText: 'x', negated: true, unresolvedPeopleNames: [] });
    expect(JSON.stringify(session)).toBe(snapshot);
  });

  test('a group-scoped draft carries the group scope through, not silently reset to personal', () => {
    const session = makeSession({ draft: { ...emptyDraft('group', 555), title: 'Standup' } });
    const payload = buildAiHandoffPayload({ session, rawText: 'x', negated: false, unresolvedPeopleNames: [] });
    expect(payload.scope).toBe('group');
    expect(payload.draft.groupId).toBe(555);
  });

  test('a null pendingField (already a complete draft) is carried through, not coerced to a string', () => {
    const session = makeSession({ pendingField: null });
    const payload = buildAiHandoffPayload({ session, rawText: 'x', negated: false, unresolvedPeopleNames: [] });
    expect(payload.pendingQuestion).toBeNull();
  });
});

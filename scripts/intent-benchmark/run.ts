// Runs one annotated conversation through the real intent layer in an isolated fixture and judges the result.
import type { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import type { Anchor } from './anchor.ts';
import { type Conversation, expandPlaceholders } from './history.ts';
import { type Expected, expectedFor, isWriteFamily, judge, type Verdict } from './oracle.ts';
import { type Finding, hardFindings, rubricFindings } from './rubric.ts';
import { buildFixture, type RuleSetTemplate, type TurnObservation } from './world.ts';

export interface RunDeps {
  template: RuleSetTemplate;
  matcher: IntentMatcher;
}

export interface RunResult {
  id: string;
  anchorLabel: string;
  tz: string;
  conversation: Conversation;
  expected: Expected;
  verdict: Verdict;
  turns: TurnObservation[];
  findings: Finding[];
  /** The first turn was answered by a rule and no AI turn follows it. */
  aiTurnAvoided: boolean;
  ruleName: string | undefined;
}

const MAX_FOLLOW_UPS = 3;

function defaultAnswer(conversation: Conversation, confirm: 'yes' | 'no'): string {
  if (confirm === 'yes') return conversation.lang === 'ru' ? 'Да' : 'Yes';
  return conversation.lang === 'ru' ? 'Отмена' : 'Cancel';
}

export async function runConversation(
  deps: RunDeps,
  conversation: Conversation,
  anchor: Anchor,
  id: string,
): Promise<RunResult> {
  const fixture = buildFixture(deps.template, deps.matcher, conversation, anchor);
  try {
    const world = fixture.worldEvents();
    const expected = expectedFor(conversation, anchor, world);
    const confirm =
      expected.kind === 'rule'
        ? expected.confirm
        : conversation.expect.route === 'rule'
          ? (conversation.expect.confirm ?? 'yes')
          : 'yes';
    const before = fixture.snapshot();
    const turns: TurnObservation[] = [];
    const sent: string[] = [];
    const say = async (raw: string) => {
      const text = expandPlaceholders(raw, anchor.date);
      sent.push(text);
      const turn = await fixture.say(text);
      turns.push(turn);
      return turn;
    };
    const first = await say(conversation.say);
    const afterFirstTurn = fixture.snapshot();
    const scripted = [...(conversation.then ?? [])];
    for (let step = 0; step < MAX_FOLLOW_UPS && first.handled === true && fixture.sessionOpen(); step++) {
      await say(scripted.shift() ?? defaultAnswer(conversation, confirm));
    }
    const after = fixture.snapshot();
    const verdict = judge(anchor, expected, {
      turns,
      before,
      afterFirstTurn,
      after,
      worldEvents: world,
    });
    const findings =
      expected.kind === 'rule' && first.handled === true
        ? rubricFindings({
            conversation,
            anchor,
            expected,
            userTexts: sent,
            turns,
            worldEvents: world,
            isWrite: isWriteFamily(expected.family),
          })
        : [];
    return {
      id,
      anchorLabel: anchor.label,
      tz: anchor.tz,
      conversation,
      expected,
      verdict,
      turns,
      findings,
      aiTurnAvoided: first.handled === true && !first.needsSupplement,
      ruleName: first.ruleName,
    };
  } finally {
    fixture.close();
  }
}

export const hasHardFinding = (result: RunResult): boolean => hardFindings(result.findings).length > 0;

// Intent simulator: runs each case through the real IntentMatcher, the real matcher layer
// (createIntentMatcherLayer), IntentExecutor and executeTool on a fresh copy of a migrated in-memory
// SQLite database holding only the given rules and the case's synthetic calendar. Runs only inside
// the child process (scripts/intent-simulate.ts, spawned by ./child.ts), whose preload freezes the
// clock at each case's time; ./sandbox.ts decides which tools may run. When a rule suspends with a
// yes-like option the simulator answers it once, which is how a confirmed write is observed.
import { Database } from 'bun:sqlite';
import { createIntentMatcherLayer } from '../../../bot/pipeline/intent-matcher-layer.ts';
import { migrations } from '../../../database/migrations.ts';
import { IntentRepository } from '../../../database/repositories/intent.repository.ts';
import { WorkflowSessionRepository } from '../../../database/repositories/workflow-session.repository.ts';
import { runMigrations } from '../../../database/schema.ts';
import { executeTool, isMutationTool } from '../../ai/tool-executor.ts';
import type { ToolResult } from '../../ai/types.ts';
import { IntentExecutor } from '../intent-executor.ts';
import type { IntentMatcher, MatchDecision } from '../intent-matcher.ts';
import type { CanonicalSeed } from '../seed-replacement.ts';
import { setCaseClock } from './case-clock.ts';
import { checkGrounding } from './grounding.ts';
import { ruleRouter, ruleRows } from './routing.ts';
import { sandboxDecision } from './sandbox.ts';
import { type CaseWorld, openCaseWorld } from './sandbox-world.ts';

export interface SyntheticEvent {
  title: string;
  start: string;
  end?: string;
}
export interface SimulationCase {
  caseId: string;
  request: string;
  at: string;
  timezone: string;
  language: 'ru' | 'en';
  calendar: SyntheticEvent[];
}
export type AbstentionReason = Extract<MatchDecision, { kind: 'abstain' }>['reason'];
export interface SimulatedTool {
  name: string;
  success: boolean;
  afterConfirmation: boolean;
  write: boolean;
}
export interface SimulationOutcome {
  caseId: string;
  routed: { status: 'matched'; intent: string } | { status: 'abstained'; reason: AbstentionReason };
  /** False when a matched rule failed without writing and the message went on to the AI agent. */
  handled: boolean;
  tools: SimulatedTool[];
  writeOutcome: 'none' | 'applied' | 'unknown';
  askedConfirmation: boolean;
  askedClarification: boolean;
  /** Tools (or a message to another chat) that would have reached someone outside the requester. */
  blockedExternal: string[];
  /** Tools answered by the simulator instead of their handler (image rendering). */
  stubbed: string[];
  reply: string | null;
  grounding: { grounded: boolean; ungrounded: string[] };
  /** A throw that escaped the layer while this case ran; the other cases still run. */
  error: string | null;
}

/** Confirmation options the harness answers; a test keeps it in step with the seed's `ok` strings. */
export const YES_ANSWERS: ReadonlySet<string> = new Set([
  'да',
  'yes',
  'ok',
  'ок',
  'подтвердить',
  'подтверждаю',
  'confirm',
]);
const USER_BASE = 700_000_000;

/** A migrated database holding the rules as approved, unmanaged rows, serialized for per-case copies. */
function buildTemplate(rules: readonly CanonicalSeed[]): Uint8Array {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    runMigrations(db, migrations);
    const insert = db.query(
      `INSERT INTO intents (id, canonical_name, pattern, phrases, trigger_words, workflow, status, format, source_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of ruleRows(rules))
      insert.run(
        row.id,
        row.canonical_name,
        row.pattern,
        row.phrases,
        row.trigger_words,
        row.workflow,
        row.status,
        row.format,
        row.source_message,
      );
    return db.serialize();
  } finally {
    db.close();
  }
}

/** Records every tool call of one run and answers the ones the sandbox does not let run. */
class ToolRecorder {
  readonly tools: SimulatedTool[] = [];
  readonly blocked: string[] = [];
  readonly stubbed: string[] = [];
  readonly texts: string[] = [];
  confirmed = false;
  writeOutcome: SimulationOutcome['writeOutcome'] = 'none';

  constructor(private readonly world: CaseWorld) {}

  readonly call = async (name: string, input: unknown): Promise<ToolResult> => {
    const write = isMutationTool(name, input);
    const decision = sandboxDecision(name);
    if (decision === 'blocked') {
      this.blocked.push(name);
      this.tools.push({ name, success: false, afterConfirmation: this.confirmed, write });
      return { success: false, error: 'simulation_blocked', mutationState: 'not_applied' };
    }
    if (decision === 'stubbed') {
      this.stubbed.push(name);
      this.tools.push({ name, success: true, afterConfirmation: this.confirmed, write });
      return { success: true, output: 'simulation: image delivery stubbed' };
    }
    const result = await executeTool(this.world.agentCtx, name, input);
    this.record(name, write, result);
    return result;
  };

  private record(name: string, write: boolean, result: ToolResult): void {
    this.tools.push({ name, success: result.success, afterConfirmation: this.confirmed, write });
    this.texts.push(result.output ?? '', result.error ?? '', JSON.stringify(result.data ?? null));
    const mutation = result.mutationState ?? (write ? (result.success ? 'confirmed' : 'uncertain') : 'not_applied');
    if (mutation === 'uncertain') this.writeOutcome = 'unknown';
    else if (mutation === 'confirmed' && this.writeOutcome === 'none') this.writeOutcome = 'applied';
  }
}

interface Conversation {
  handled: boolean;
  askedConfirmation: boolean;
  askedClarification: boolean;
  reply: string | null;
}

/** First turn, then at most one "yes" to a confirmation prompt; any other suspension is a question. */
async function converse(
  world: CaseWorld,
  recorder: ToolRecorder,
  layer: ReturnType<typeof createIntentMatcherLayer>,
  sessions: WorkflowSessionRepository,
  request: string,
): Promise<Conversation> {
  const chat = world.user.telegram_id;
  const first = await layer(world.turn(request), request);
  const state: Conversation = {
    handled: first.handled,
    askedConfirmation: false,
    askedClarification: false,
    reply: null,
  };
  let delivered = world.takeDelivered();
  let pending = sessions.get(chat, chat);
  if (pending) {
    const yes = pending.pendingPrompt?.options?.find((option) => YES_ANSWERS.has(option.trim().toLowerCase()));
    if (yes === undefined) state.askedClarification = true;
    else {
      state.askedConfirmation = true;
      recorder.confirmed = true;
      const second = await layer(world.turn(yes), yes);
      state.handled &&= second.handled;
      // The reply is what the requester reads after confirming, not the confirmation prompt.
      delivered = world.takeDelivered();
      pending = sessions.get(chat, chat);
      if (pending) state.askedClarification = true;
    }
  }
  const text = delivered.join('\n').trim();
  state.reply = text.length > 0 ? text : null;
  if (!pending && state.reply?.endsWith('?') && !recorder.tools.some((tool) => tool.write))
    state.askedClarification = true;
  return state;
}

function eventInstants(world: CaseWorld): string[] {
  const rows = world.db
    .query<{ start_at: string; end_at: string | null }, [number]>(
      'SELECT start_at, end_at FROM events WHERE user_id = ?',
    )
    .all(world.user.telegram_id);
  return rows.flatMap((row) => (row.end_at ? [row.start_at, row.end_at] : [row.start_at]));
}

async function simulateMatched(
  world: CaseWorld,
  matcher: IntentMatcher,
  simulationCase: SimulationCase,
  intent: string,
): Promise<SimulationOutcome> {
  const recorder = new ToolRecorder(world);
  const sessions = new WorkflowSessionRepository(world.db);
  const layer = createIntentMatcherLayer(
    matcher,
    new IntentRepository(world.db),
    new IntentExecutor(),
    recorder.call,
    sessions,
  );
  let conversation: Conversation;
  let error: string | null = null;
  try {
    conversation = await converse(world, recorder, layer, sessions, simulationCase.request);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    conversation = { handled: false, askedConfirmation: false, askedClarification: false, reply: null };
  }
  const grounding = conversation.reply
    ? checkGrounding(conversation.reply, {
        toolTexts: recorder.texts,
        instants: eventInstants(world),
        timezone: simulationCase.timezone,
        now: simulationCase.at,
      })
    : { grounded: false, ungrounded: [] };
  const foreign = world.foreignChats.length > 0 ? ['message_to_other_chat'] : [];
  return {
    caseId: simulationCase.caseId,
    routed: { status: 'matched', intent },
    handled: conversation.handled,
    tools: recorder.tools,
    writeOutcome: recorder.writeOutcome,
    askedConfirmation: conversation.askedConfirmation,
    askedClarification: conversation.askedClarification,
    blockedExternal: [...recorder.blocked, ...foreign],
    stubbed: recorder.stubbed,
    reply: conversation.reply,
    grounding,
    error,
  };
}

function abstained(caseId: string, reason: AbstentionReason): SimulationOutcome {
  return {
    caseId,
    routed: { status: 'abstained', reason },
    handled: false,
    tools: [],
    writeOutcome: 'none',
    askedConfirmation: false,
    askedClarification: false,
    blockedExternal: [],
    stubbed: [],
    reply: null,
    grounding: { grounded: false, ungrounded: [] },
    error: null,
  };
}

export async function simulateCases(
  rules: readonly CanonicalSeed[],
  cases: readonly SimulationCase[],
): Promise<SimulationOutcome[]> {
  const template = buildTemplate(rules);
  const { matcher, nameOf } = ruleRouter(rules);
  const outcomes: SimulationOutcome[] = [];
  for (const [index, simulationCase] of cases.entries()) {
    setCaseClock(simulationCase.at);
    const decision = matcher.explain(simulationCase.request);
    if (decision.kind !== 'matched') {
      outcomes.push(abstained(simulationCase.caseId, decision.reason));
      continue;
    }
    const world = openCaseWorld(template, simulationCase, USER_BASE + index);
    try {
      outcomes.push(await simulateMatched(world, matcher, simulationCase, nameOf(decision.result.intentId)));
    } finally {
      world.db.close();
    }
  }
  return outcomes;
}

import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { aiStreamRound } from '../../../src/services/ai/streaming.ts';
import type { TelegramSender } from '../../../src/services/ai/types.ts';
import {
  createAgentRunFixture,
  isValidatorCall,
  makeStreamImpl,
  type ScriptedRound,
  shownEdits,
  USER_ID,
} from './agent-run-helpers.ts';

interface ClockBoundary {
  before: string;
  after: string;
  timezone: string;
  messageText: string;
  responseText: string;
  includeMidnightEvents?: boolean;
}

/** Exercise the real run, crossing the clock boundary while its initial Telegram send is pending. */
async function runAcrossClockBoundary(boundary: ClockBoundary) {
  setSystemTime(new Date(boundary.before));
  const { db, ctx, config, sender } = createAgentRunFixture();
  ctx.user = { ...ctx.user, timezone: boundary.timezone };
  ctx.messageText = boundary.messageText;
  ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
  if (boundary.includeMidnightEvents) {
    for (const [title, startAt] of [
      ['Evening note', '2026-11-16T18:00:00Z'],
      ['After midnight note', '2026-11-16T20:15:00Z'],
    ]) {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: title!,
        start_at: startAt!,
        timezone: boundary.timezone,
      });
    }
    ctx.recentEventsWindow = ctx.eventService.getEventsInRange(USER_ID, '2026-11-15T20:00:00Z', '2026-11-17T20:00:00Z');
  }

  const sendMessage = sender.sendMessage;
  sender.sendMessage = async (...args) => {
    const sent = await sendMessage(...args);
    setSystemTime(new Date(boundary.after));
    return sent;
  };
  const scripted = makeStreamImpl([{ kind: 'text', text: boundary.responseText }]);
  let agentPrompt = '';
  let validatorPrompt = '';
  const streamImpl: typeof aiStreamRound = async (options, callbacks) => {
    if (isValidatorCall(options)) {
      validatorPrompt = String(options.messages[1]?.content ?? '');
    } else {
      agentPrompt = String(options.messages[0]?.content ?? '');
    }
    return scripted.impl(options, callbacks);
  };

  try {
    const result = await new CalendarBotAgent(config, sender, { streamImpl }).run(ctx);
    return { result, agentPrompt, validatorPrompt, dayReferences: ctx.dayReferences };
  } finally {
    db.close();
  }
}

function lineStartingWith(text: string, prefix: string): string | undefined {
  return text.split('\n').find((line) => line.startsWith(prefix));
}

const MIDNIGHT = {
  before: '2026-11-16T19:59:59Z',
  after: '2026-11-16T20:00:01Z',
  timezone: 'Asia/Tbilisi',
};

describe('CalendarBotAgent shared turn clock', () => {
  afterEach(() => setSystemTime());

  test('initialization crossing local midnight keeps prompt, day guard and validator on the same day', async () => {
    const run = await runAcrossClockBoundary({
      ...MIDNIGHT,
      messageText: 'Can you help tomorrow?',
      responseText: 'What would you like to plan?',
      includeMidnightEvents: true,
    });

    expect({
      response: run.result.responseText,
      promptClock: lineStartingWith(run.agentPrompt, '- Current local time:'),
      tomorrow: run.dayReferences?.references[0]?.dates[0],
      todayMarker: lineStartingWith(run.agentPrompt, 'Nov 16 Mon'),
      followingDay: lineStartingWith(run.agentPrompt, 'Nov 17 Tue'),
      validatorDay: lineStartingWith(run.validatorPrompt, 'TODAY IN USER TIMEZONE:'),
    }).toEqual({
      response: 'What would you like to plan?',
      promptClock: '- Current local time: 2026-11-16 Mon 23:59',
      tomorrow: '2026-11-17',
      todayMarker: 'Nov 16 Mon ← today: 22:00 Evening note',
      followingDay: 'Nov 17 Tue: 00:15 After midnight note',
      validatorDay: 'TODAY IN USER TIMEZONE: 2026-11-16, Monday',
    });
  });

  test('the validator profile uses the prompt clock after local midnight', async () => {
    const run = await runAcrossClockBoundary({
      ...MIDNIGHT,
      messageText: 'What is my timezone?',
      responseText: 'Your timezone is Asia/Tbilisi.',
    });

    expect(run.result.responseText).toBe('Your timezone is Asia/Tbilisi.');
    expect(lineStartingWith(run.agentPrompt, '- Current local time:')).toBe(
      '- Current local time: 2026-11-16 Mon 23:59',
    );
    expect(lineStartingWith(run.validatorPrompt, '- Current local time:')).toBe(
      '- Current local time: 2026-11-16 Mon 23:59',
    );
  });

  test('the prompt and validator profile use the turn instant for the timezone offset across DST', async () => {
    const run = await runAcrossClockBoundary({
      before: '2026-10-25T00:59:59Z',
      after: '2026-10-25T01:00:01Z',
      timezone: 'Europe/Belgrade',
      messageText: 'What is my timezone?',
      responseText: 'Your timezone is Europe/Belgrade.',
    });

    expect(run.result.responseText).toBe('Your timezone is Europe/Belgrade.');
    for (const prompt of [run.agentPrompt, run.validatorPrompt]) {
      expect(lineStartingWith(prompt, '- Current local time:')).toBe('- Current local time: 2026-10-25 Sun 02:59');
      expect(lineStartingWith(prompt, '- Timezone:')).toBe('- Timezone: Europe/Belgrade (UTC+2)');
    }
  });
});

interface ScriptBoundary extends Pick<ClockBoundary, 'before' | 'after' | 'timezone' | 'messageText'> {
  rounds: ScriptedRound[];
  toolSchemaMode: 'full' | 'lazy';
  seedLunch?: boolean;
  rejectFirstValidation?: boolean;
  supplementMode?: boolean;
}

async function runScriptAcrossClockBoundary(boundary: ScriptBoundary) {
  setSystemTime(new Date(boundary.before));
  const { db, ctx, config, sender } = createAgentRunFixture();
  ctx.user = { ...ctx.user, timezone: boundary.timezone };
  ctx.messageText = boundary.messageText;
  ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
  if (boundary.supplementMode) {
    ctx.supplementMode = true;
    ctx.supplementAutoResponse = 'Here is your saved calendar.';
  }
  if (boundary.seedLunch) {
    ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Lunch',
      start_at: '2026-11-17T08:00:00Z',
      timezone: boundary.timezone,
    });
  }
  const detailsBeforeQuestions: string[][] = [];
  const sendButtons = mock<NonNullable<TelegramSender['sendButtons']>>(async () => {
    detailsBeforeQuestions.push(shownEdits(sender));
    return { message_id: 43 };
  });
  sender.sendButtons = sendButtons;
  const sendMessage = sender.sendMessage;
  let crossed = false;
  sender.sendMessage = async (...args) => {
    const sent = await sendMessage(...args);
    setSystemTime(new Date(boundary.after));
    crossed = true;
    return sent;
  };
  const scripted = makeStreamImpl(boundary.rounds);
  const validatorPrompts: string[] = [];
  const agentPrompts: string[] = [];
  const streamImpl: typeof aiStreamRound = async (options, callbacks) => {
    if (isValidatorCall(options)) {
      validatorPrompts.push(String(options.messages[1]?.content ?? ''));
      const verdict = await scripted.impl(options, callbacks);
      if (boundary.rejectFirstValidation && validatorPrompts.length === 1) {
        const text = 'REJECT: answer the requested date or ask the clarification using tools';
        return { ...verdict, text, assistantMessage: { role: 'assistant' as const, content: text } };
      }
      return verdict;
    }
    agentPrompts.push(String(options.messages[0]?.content ?? ''));
    // A supplement has a silent sender, so cross after its prompt was built instead of
    // waiting for a Telegram placeholder. It still uses the same captured turn instant.
    if (!crossed) {
      setSystemTime(new Date(boundary.after));
      crossed = true;
    }
    return scripted.impl(options, callbacks);
  };
  try {
    const result = await new CalendarBotAgent({ ...config, toolSchemaMode: boundary.toolSchemaMode }, sender, {
      streamImpl,
    }).run(ctx);
    return {
      result,
      agentPrompts,
      validatorPrompts,
      edits: shownEdits(sender),
      questions: sendButtons.mock.calls.map((call) => ({ text: call[1], options: call[2] })),
      detailsBeforeQuestions,
      history: JSON.stringify(ctx.chatHistory.getRecent(USER_ID)),
      toolMessages: scripted.calls.flatMap(({ messages }) =>
        messages.flatMap((message) =>
          message.role === 'tool' ? [{ id: message.tool_call_id, content: String(message.content) }] : [],
        ),
      ),
    };
  } finally {
    db.close();
  }
}

function reveal(mode: 'full' | 'lazy', name: string): ScriptedRound[] {
  return mode === 'lazy'
    ? [{ kind: 'tool', callId: 'schema', name: 'discover_tools', input: { groups: [], tools: [name] } }]
    : [];
}

const READ_LUNCH: ScriptedRound = {
  kind: 'tool',
  callId: 'lunch-read',
  name: 'get_events',
  input: { start_date: '2026-11-17', end_date: '2026-11-17' },
};
const WRONG_TOMORROW = 'Tomorrow, November 18: Lunch at 12:00.';
const RIGHT_TOMORROW = 'Tomorrow, November 17: Lunch at 12:00.';
const NEAREST_YEAR_BOUNDARY = {
  before: '2026-11-15T19:59:59Z',
  after: '2026-11-15T20:00:01Z',
  timezone: 'Asia/Tbilisi',
};
const WEEKDAY_PATHS = [
  { toolSchemaMode: 'full', retry: false },
  { toolSchemaMode: 'lazy', retry: true },
] as const;

describe('CalendarBotAgent uses the turn clock in final and clarification guards', () => {
  afterEach(() => setSystemTime());

  test.each([
    'full',
    'lazy',
  ] as const)('%s: a successful schedule read cannot exempt a wrong tomorrow from validation', async (toolSchemaMode) => {
    const run = await runScriptAcrossClockBoundary({
      ...MIDNIGHT,
      messageText: 'Show my plans for tomorrow.',
      toolSchemaMode,
      seedLunch: true,
      rejectFirstValidation: true,
      rounds: [
        ...reveal(toolSchemaMode, 'get_events'),
        READ_LUNCH,
        { kind: 'text', text: WRONG_TOMORROW },
        { kind: 'text', text: RIGHT_TOMORROW },
      ],
    });
    const readEvidence = run.toolMessages
      .filter(({ id }) => id === 'lunch-read')
      .map(({ content }) => content)
      .join('\n');
    expect(readEvidence).toContain('Lunch');
    expect(readEvidence).not.toContain('WRONG_DAY');
    expect(run.result.toolCalls.map(({ name }) => name)).toContain('get_events');
    expect(run.result.responseText).toBe(RIGHT_TOMORROW);
    expect(run.edits.at(-1)).toContain(RIGHT_TOMORROW);
    expect(run.history).toContain(RIGHT_TOMORROW);
    expect(run.history).not.toContain(WRONG_TOMORROW);
    expect(run.validatorPrompts[0]).toContain('TODAY IN USER TIMEZONE: 2026-11-16, Monday');
    expect(run.validatorPrompts[0]).toContain(WRONG_TOMORROW);
  });

  test('a supplement drops a wrong tomorrow even after its successful schedule read', async () => {
    const run = await runScriptAcrossClockBoundary({
      ...MIDNIGHT,
      messageText: 'Show my plans for tomorrow.',
      toolSchemaMode: 'full',
      seedLunch: true,
      supplementMode: true,
      rounds: [READ_LUNCH, { kind: 'text', text: WRONG_TOMORROW }],
    });
    expect(run.toolMessages.some(({ id, content }) => id === 'lunch-read' && content.includes('Lunch'))).toBe(true);
    expect(run.result.responseText).not.toContain(WRONG_TOMORROW);
    expect(run.history).not.toContain(WRONG_TOMORROW);
    expect(run.validatorPrompts).toHaveLength(0);
  });

  test.each([
    ...WEEKDAY_PATHS,
  ])('$toolSchemaMode, retry=$retry: valid nearest-year weekday prose is delivered and saved', async ({
    toolSchemaMode,
    retry,
  }) => {
    const correct = 'Sunday, May 17.';
    const run = await runScriptAcrossClockBoundary({
      ...NEAREST_YEAR_BOUNDARY,
      messageText: 'What weekday is May 17?',
      toolSchemaMode,
      rejectFirstValidation: retry,
      rounds: [
        ...(retry ? [{ kind: 'text' as const, text: 'I can help with that.' }] : []),
        { kind: 'text', text: correct },
        { kind: 'text', text: correct },
      ],
    });
    expect(lineStartingWith(run.agentPrompts[0] ?? '', '- Current local time:')).toBe(
      '- Current local time: 2026-11-15 Sun 23:59',
    );
    expect(run.result.responseText).toBe(correct);
    expect(run.edits.at(-1)).toContain(correct);
    expect(run.history).toContain(correct);
    expect(run.history).not.toContain('May 17 is a Monday');
    if (retry) expect(run.validatorPrompts.length).toBeGreaterThan(0);
  });

  test.each([
    ...WEEKDAY_PATHS,
  ])('$toolSchemaMode, retry=$retry: valid nearest-year clarification reaches its button and tool detail', async ({
    toolSchemaMode,
    retry,
  }) => {
    const question = 'Sunday, May 17?';
    const run = await runScriptAcrossClockBoundary({
      ...NEAREST_YEAR_BOUNDARY,
      messageText: 'Can you confirm May 17?',
      toolSchemaMode,
      rejectFirstValidation: retry,
      rounds: [
        ...reveal(toolSchemaMode, 'ask_user'),
        ...(retry ? [{ kind: 'text' as const, text: 'I can help with that.' }] : []),
        { kind: 'tool', callId: 'date-question', name: 'ask_user', input: { question, options: ['Yes', 'No'] } },
        { kind: 'text', text: 'Which date would you prefer?' },
      ],
    });
    expect(run.questions).toHaveLength(1);
    expect(run.questions[0]?.text).toBe(question);
    expect(run.questions[0]?.options).toContain('Yes');
    expect(run.detailsBeforeQuestions[0]?.some((text) => text.includes(question))).toBe(true);
    expect(run.history).toContain(question);
    expect(run.history).not.toContain('WEEKDAY_DATE_MISMATCH');
    if (retry) expect(run.validatorPrompts.length).toBeGreaterThan(0);
  });
});

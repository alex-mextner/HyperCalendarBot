import type { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import {
  createAgentRunFixture,
  fakeMetrics,
  isValidatorCall,
  makeStreamImpl,
  shownEdits,
  USER_ID,
} from './agent-run-helpers.ts';

describe('CalendarBotAgent.run()', () => {
  let db: Database;
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;

  beforeEach(() => {
    ({ db, ctx, config, sender } = createAgentRunFixture());
  });

  test('a create for a day the user did not name is rejected before dispatch and redone for the named day', async () => {
    // 2026-09-27 23:01 Belgrade: "Среда английский 12:30" was resolved to Monday the 28th.
    setSystemTime(new Date('2026-09-27T21:00:00Z'));
    try {
      ctx.user = { ...ctx.user, timezone: 'Europe/Belgrade' };
      ctx.messageText = 'Среда английский 12:30';
      const { impl, calls } = makeStreamImpl([
        {
          kind: 'tool',
          callId: 'call-1',
          name: 'create_event',
          input: { title: 'Английский', start_at: '2026-09-28T10:30:00Z' },
        },
        {
          kind: 'tool',
          callId: 'call-2',
          name: 'create_event',
          input: { title: 'Английский', start_at: '2026-09-30T10:30:00Z' },
        },
        { kind: 'text', text: 'Записала английский на среду, 30 сентября, 12:30.' },
      ]);
      ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
      await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

      const rejection = calls[1]?.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call-1');
      expect(String(rejection?.content)).toContain('WRONG_DAY');
      expect(String(rejection?.content)).toContain('«среда» = Wednesday 2026-09-30');
      const rows = db.query<{ start_at: string }, []>('SELECT start_at FROM events WHERE is_deleted = 0').all();
      expect(rows.map((row) => row.start_at)).toEqual(['2026-09-30T10:30:00Z']);
    } finally {
      setSystemTime();
    }
  });

  test('a "Да" in a group is checked against the question asked in that group', async () => {
    const GROUP = -100777;
    setSystemTime(new Date('2026-09-27T21:00:00Z'));
    try {
      ctx.user = { ...ctx.user, timezone: 'Europe/Belgrade' };
      ctx.isGroup = true;
      ctx.groupChatId = GROUP;
      ctx.messageText = 'Да';
      const past = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Английский',
        start_at: '2026-09-01T11:30:00Z',
        timezone: 'Europe/Belgrade',
        owner_type: 'group',
        group_id: GROUP,
        created_by: USER_ID,
      }).id;
      const ask = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'ask-1',
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({ question: 'Удалить английский во вторник, 29 сентября?', options: ['Да'] }),
            },
          },
        ],
      };
      ctx.chatHistory.save(USER_ID, 'user', 'Во вторник отмени английский', GROUP);
      ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify(ask), GROUP);
      ctx.chatHistory.save(
        USER_ID,
        'tool',
        JSON.stringify([{ role: 'tool', tool_call_id: 'ask-1', content: 'Вопрос отправлен.' }]),
        GROUP,
      );
      ctx.chatHistory.save(USER_ID, 'user', 'Да', GROUP);
      // Rows carry the mocked clock, as production rows carry the real one.
      db.run('UPDATE chat_history SET created_at = ?', ['2026-09-27 21:00:00']);
      const { impl, calls } = makeStreamImpl([
        { kind: 'tool', callId: 'call-1', name: 'delete_event', input: { event_id: past } },
        { kind: 'text', text: 'Не удалила: это было 1 сентября.' },
      ]);
      await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

      const rejection = calls[1]?.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call-1');
      expect(String(rejection?.content)).toContain('«вторник» = Tuesday 2026-09-29');
      expect(ctx.eventService.getEventForGroup(past, GROUP)).not.toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test('a reply pairing a weekday with a date on another weekday is corrected before delivery', async () => {
    // 2026-09-27 23:12 Belgrade: "Планы на среду" was answered "Среда, 28 сентября" (a Monday).
    setSystemTime(new Date('2026-09-27T21:12:00Z'));
    try {
      ctx.user = { ...ctx.user, timezone: 'Europe/Belgrade' };
      ctx.messageText = 'Планы на среду';
      const wrong = 'Среда, 28 сентября: событий нет.';
      const right = 'Среда, 30 сентября: событий нет.';
      const { impl, calls } = makeStreamImpl([
        {
          kind: 'tool',
          callId: 'call-1',
          name: 'get_events',
          input: { start_date: '2026-09-30', end_date: '2026-09-30' },
        },
        { kind: 'text', text: wrong },
        { kind: 'text', text: right },
      ]);
      ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

      expect(result.responseText).toBe(right);
      const correction = calls[2]?.messages.at(-1);
      expect(String(correction?.content)).toContain('2026-09-28 is a Monday, not a Wednesday');
      expect(String(correction?.content)).toContain('the nearest Wednesday is 2026-09-30');
      // The wrong pair is held back while streaming: no edit ever showed it.
      expect(shownEdits(sender).filter((text) => text.includes('28 сентября'))).toEqual([]);
      expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain(wrong);
    } finally {
      setSystemTime();
    }
  });

  test('a reply still mismatched after the correction is replaced by the real weekdays', async () => {
    setSystemTime(new Date('2026-09-27T21:12:00Z'));
    try {
      ctx.user = { ...ctx.user, timezone: 'Europe/Belgrade', language: 'ru' };
      ctx.messageText = 'Планы на среду';
      const wrong = 'Среда, 28 сентября: событий нет.';
      const { impl, calls } = makeStreamImpl([
        {
          kind: 'tool',
          callId: 'call-1',
          name: 'get_events',
          input: { start_date: '2026-09-30', end_date: '2026-09-30' },
        },
        { kind: 'text', text: wrong },
        { kind: 'text', text: wrong },
      ]);
      ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

      expect(calls).toHaveLength(3);
      expect(result.responseText).not.toContain(wrong);
      expect(result.responseText).toContain('28 сентября — понедельник, а не среда; среда — 30 сентября');
      expect(shownEdits(sender).filter((text) => text.includes(wrong))).toEqual([]);
      const history = JSON.stringify(ctx.chatHistory.getRecent(USER_ID));
      expect(history).not.toContain(wrong);
      expect(history).toContain('28 сентября — понедельник');
    } finally {
      setSystemTime();
    }
  });

  test('a mismatched reply in the last allowed round is replaced by the real weekdays, not left blank', async () => {
    setSystemTime(new Date('2026-09-27T21:12:00Z'));
    try {
      ctx.user = { ...ctx.user, timezone: 'Europe/Belgrade', language: 'ru' };
      ctx.messageText = 'Планы на среду';
      const wrong = 'Среда, 28 сентября: событий нет.';
      const reads = Array.from({ length: 14 }, (_, index) => ({
        kind: 'tool' as const,
        callId: `call-${index}`,
        name: 'get_events',
        input: { start_date: '2026-09-30', end_date: `2026-10-${String(index + 1).padStart(2, '0')}` },
      }));
      const { impl, calls } = makeStreamImpl([...reads, { kind: 'text', text: wrong }]);
      ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

      expect(calls).toHaveLength(15);
      expect(result.responseText).toContain('28 сентября — понедельник, а не среда; среда — 30 сентября');
    } finally {
      setSystemTime();
    }
  });

  test('a rejected ask_user question never shows its pair in the label, even when the label is cut short', async () => {
    setSystemTime(new Date('2026-09-27T21:12:00Z'));
    try {
      ctx.user = { ...ctx.user, timezone: 'Europe/Belgrade', language: 'ru' };
      ctx.messageText = 'Перенеси встречу';
      // 27 January 2027 is a Wednesday; the label cuts the question inside "января".
      const question = 'Сдвинуть всю встречу с Леной на понедельник 27 января?';
      const { impl } = makeStreamImpl([
        { kind: 'tool', callId: 'ask', name: 'ask_user', input: { question, options: ['Да', 'Нет'] } },
        { kind: 'text', text: 'Уточни, на какой день перенести встречу.' },
      ]);
      ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
      await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

      expect(shownEdits(sender).filter((text) => text.includes('понедельник 27'))).toEqual([]);
    } finally {
      setSystemTime();
    }
  });

  test('a validator retry that pairs a weekday with the wrong date is not delivered', async () => {
    setSystemTime(new Date('2026-09-27T21:12:00Z'));
    try {
      ctx.user = { ...ctx.user, timezone: 'Europe/Belgrade', language: 'en' };
      ctx.messageText = 'Plans for Wednesday';
      const script = makeStreamImpl([
        { kind: 'text', text: 'Nothing planned for Wednesday.' },
        {
          kind: 'tool',
          callId: 'call-1',
          name: 'get_events',
          input: { start_date: '2026-09-30', end_date: '2026-09-30' },
        },
        { kind: 'text', text: 'Wednesday, September 28: nothing planned.' },
      ]);
      let validators = 0;
      const impl: typeof script.impl = async (opts, cbs) => {
        if (!isValidatorCall(opts)) return script.impl(opts, cbs);
        const verdict = validators++ === 0 ? 'REJECT: no calendar evidence' : 'APPROVE';
        return {
          text: verdict,
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant' as const, content: verdict },
          providerUsed: 'mock-validator',
          metrics: fakeMetrics('hf', 10, 2),
        };
      };
      ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

      expect(result.responseText).not.toContain('Wednesday, September 28');
      expect(result.responseText).toContain('September 28 is a Monday, not a Wednesday; Wednesday is September 30');
    } finally {
      setSystemTime();
    }
  });

  test('narration before a tool call that pairs a weekday with the wrong date stays out of the reply', async () => {
    setSystemTime(new Date('2026-09-27T21:12:00Z'));
    try {
      ctx.user = { ...ctx.user, timezone: 'Europe/Belgrade' };
      ctx.messageText = 'Планы на среду';
      const { impl } = makeStreamImpl([
        {
          kind: 'tool',
          callId: 'call-1',
          name: 'get_events',
          text: 'Смотрю среду, 28 сентября, в календаре.',
          input: { start_date: '2026-09-30', end_date: '2026-09-30' },
        },
        { kind: 'text', text: 'Среда, 30 сентября: событий нет.' },
      ]);
      ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

      expect(result.responseText).toBe('Среда, 30 сентября: событий нет.');
      expect(shownEdits(sender).filter((text) => text.includes('28 сентября'))).toEqual([]);
    } finally {
      setSystemTime();
    }
  });

  test('a reply pairing a weekday with the wrong date is never streamed to the user', async () => {
    // Nothing was flushed yet in this request, so a streamed draft would be shown at once.
    setSystemTime(new Date('2026-09-27T21:12:00Z'));
    try {
      ctx.user = { ...ctx.user, timezone: 'Europe/Belgrade' };
      ctx.messageText = 'Что у меня в среду?';
      const { impl } = makeStreamImpl([
        { kind: 'text', text: 'Среда, 28 сентября: событий нет.' },
        { kind: 'text', text: 'Среда, 30 сентября: событий нет.' },
      ]);
      ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

      expect(result.responseText).toBe('Среда, 30 сентября: событий нет.');
      expect(shownEdits(sender).filter((text) => text.includes('28 сентября'))).toEqual([]);
    } finally {
      setSystemTime();
    }
  });
});

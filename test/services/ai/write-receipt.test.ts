/**
 * What the user reads when a run had failed or skipped writes: the evidence guard's receipt.
 * Built on the real WriteOutcomes and planGuard with synthetic ids (secretary 1001, calendar owner
 * 2002, invitees 3001/3002); the incident is a secretary creating an event in the owner's calendar
 * whose three invitations were then all rejected.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { WRITE_TOOLS } from '../../../src/services/ai/tool-executor.ts';
import { eventToSummary } from '../../../src/services/ai/tool-handlers/events/presentation.ts';
import { WriteOutcomes } from '../../../src/services/ai/write-outcomes.ts';
import { receiptView } from '../../../src/services/ai/write-receipt.ts';
import { markdownToHtml, stripHtml } from '../../../src/utils/telegram.ts';
import { createAgentRunFixture, makeStreamImpl, setupInvitations } from './agent-run-helpers.ts';
import {
  created,
  createInput,
  eventNotFound,
  exec,
  FRIEND,
  incident,
  OWNER,
  type Recorded,
  receipt,
  receiptViewFor,
  rejectedCreate,
  SECRETARY,
  STRANGER,
  secretaryContext,
  uncertain,
} from './write-receipt-helpers.ts';

beforeEach(() => setSystemTime(new Date('2026-10-31T09:00:00Z')));
afterEach(() => setSystemTime());

describe('failed invitations after a delegated create', () => {
  test('ru: says the event exists, whose calendar, who was not invited and what to do next', () => {
    const plan = receipt(incident(), secretaryContext('ru'));
    expect(plan.guarded).toBe(true);
    expect(plan.evidence?.split('\n')).toEqual([
      'Создано: событие «Board games» (сегодня, 17:00), календарь: Olga.',
      'Приглашения на «Board games» не отправлены: @sam_demo, Friend и ещё 1 человек.',
      'Скажи, что повторить: уже выполненное я повторять не буду.',
    ]);
  });

  test('en: the same receipt', () => {
    const plan = receipt(incident(), secretaryContext('en'));
    expect(plan.evidence?.split('\n')).toEqual([
      'Created: event “Board games” (today, 17:00), calendar: Olga.',
      'The invitations to “Board games” were not sent: @sam_demo, Friend and 1 more.',
      'Tell me what to repeat: I will not redo what already went through.',
    ]);
  });

  test.each(['ru', 'en'] as const)('%s: never leaks ids, attempt jargon or the meta sentence', (language) => {
    const evidence = receipt(incident(), secretaryContext(language)).evidence ?? '';
    for (const forbidden of [
      /#\d/,
      /\d{4}/,
      'Попытка',
      'попытк',
      'Attempt',
      'attempt',
      'отклонён до',
      'rejected before',
    ]) {
      expect(evidence).not.toMatch(forbidden);
    }
    expect(evidence).not.toContain('697');
    expect(evidence).not.toContain(String(STRANGER));
  });

  test('an invitee nobody can name is counted, not shown by id', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', createInput, created);
    ledger.record('send_invitation', { event_id: 501, invitee_id: 3091 }, eventNotFound);
    ledger.record('send_invitation', { event_id: 501, invitee_id: 3092 }, eventNotFound);
    expect(receipt(ledger, secretaryContext('ru')).evidence?.split('\n')[1]).toBe(
      'Приглашения на «Board games» не отправлены: 2 человека.',
    );
  });

  test('a calendar the account no longer manages is neither named nor said to be managed', () => {
    const ctx = secretaryContext('ru');
    const record = ctx.secretary?.secretaryRepo.findByOwnerAndSecretary(OWNER, SECRETARY);
    if (!record) throw new Error('secretary record missing');
    ctx.secretary?.secretaryRepo.updateStatus(record.id, 'revoked');
    const evidence = receipt(incident(), ctx).evidence ?? '';
    expect(evidence).not.toContain('Olga');
    expect(evidence).toContain('другой календарь.');
    expect(evidence).not.toContain('секретарь');
  });

  describe('a calendar the requester has no active access to is not called one they manage', () => {
    test.each([
      ['ru', 'none', 'Создано: событие «Board games» (сегодня, 17:00), другой календарь.'],
      ['ru', 'revoked', 'Создано: событие «Board games» (сегодня, 17:00), другой календарь.'],
      ['en', 'none', 'Created: event “Board games” (today, 17:00), another calendar.'],
      ['en', 'revoked', 'Created: event “Board games” (today, 17:00), another calendar.'],
    ] as const)('%s, access %s', (language, access, expected) => {
      const evidence = receipt(incident(), secretaryContext(language, false, { access })).evidence ?? '';
      expect(evidence.split('\n')[0]).toBe(expected);
      expect(evidence).not.toMatch(/секретар|secretary|Olga|2002/);
    });

    test.each(['ru', 'en'] as const)('%s: an invented owner_id is told neutrally too', (language) => {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', { ...createInput, owner_id: 9999 }, created);
      ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
      const first = receipt(ledger, secretaryContext(language)).evidence?.split('\n')[0] ?? '';
      expect(first).toMatch(language === 'ru' ? /другой календарь\.$/ : /another calendar\.$/);
      expect(first).not.toMatch(/секретар|secretary/);
    });

    test('active access with an unreadable name keeps the secretary wording', () => {
      const evidence = receipt(incident(), secretaryContext('en', false, { owner: null })).evidence ?? '';
      expect(evidence.split('\n')[0]).toContain('you manage as a secretary');
    });

    test('a group chat hides it entirely whatever the access', () => {
      const en = receipt(incident(), secretaryContext('en', true, { access: 'none' })).evidence ?? '';
      expect(en).not.toMatch(/calendar|secretary|Board games/);
    });
  });

  // The managed owner has no display name (a profile with no first name): the receipt still says the
  // write went to someone else's calendar, without a dangling "calendar: " or the word null.
  describe('an owner whose name is unknown', () => {
    test("ru: names the calendar as someone else's, with no dangling label or id", () => {
      const evidence = receipt(incident(), secretaryContext('ru', false, { owner: null })).evidence ?? '';
      expect(evidence.split('\n')[0]).toBe(
        'Создано: событие «Board games» (сегодня, 17:00), чужой календарь, который ты ведёшь как секретарь.',
      );
      expect(evidence).not.toMatch(/календарь: ?[.\n]|null|undefined|2002/);
    });

    test('en: the same receipt', () => {
      const evidence = receipt(incident(), secretaryContext('en', false, { owner: null })).evidence ?? '';
      expect(evidence.split('\n')[0]).toBe(
        'Created: event “Board games” (today, 17:00), someone else’s calendar that you manage as a secretary.',
      );
      expect(evidence).not.toMatch(/calendar: ?[.\n]|null|undefined|2002/);
    });

    test('a group chat still hides the calendar entirely', () => {
      const ru = receipt(incident(), secretaryContext('ru', true, { owner: null })).evidence ?? '';
      const en = receipt(incident(), secretaryContext('en', true, { owner: null })).evidence ?? '';
      expect(ru.split('\n')[0]).toBe('Создано: событие.');
      expect(en).not.toMatch(/calendar|secretary|Board games/);
    });
  });

  test('a group chat shows no title, time, calendar, name or count of ids', () => {
    const ru = receipt(incident(), secretaryContext('ru', true)).evidence ?? '';
    expect(ru.split('\n')).toEqual([
      'Создано: событие.',
      'Приглашения на событие не отправлены: 3 человека.',
      'Скажи, что повторить: уже выполненное я повторять не буду.',
    ]);
    const en = receipt(incident(), secretaryContext('en', true)).evidence ?? '';
    expect(en).not.toMatch(/Board games|Olga|sam_demo|17:00/);
  });
});

describe('when the guard fires', () => {
  test('a clean success is not guarded', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', createInput, created);
    ledger.record(
      'send_invitation',
      { event_id: 501, invitee_id: FRIEND },
      {
        success: true,
        disposition: 'executed',
        mutationState: 'confirmed',
        effect: { kind: 'invitation', delivery: 'delivered' },
      },
    );
    const plan = receipt(ledger, secretaryContext('ru'));
    expect(plan).toEqual({ evidence: null, silent: false, validationNotice: null, guarded: false, interrupted: false });
  });

  test('a failure that a later write of the same event fixed is not reported and does not guard', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', createInput, { ...eventNotFound, error: 'Event time is in the past' });
    ledger.record('create_event', { ...createInput, force: true }, created);
    ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
    ledger.record(
      'send_invitation',
      { event_id: 501, invitee_id: FRIEND },
      {
        success: true,
        disposition: 'executed',
        mutationState: 'confirmed',
        effect: { kind: 'invitation', delivery: 'delivered' },
      },
    );
    const plan = receipt(ledger, secretaryContext('ru'));
    expect(plan.evidence).toBeNull();
    expect(plan.guarded).toBe(false);
  });

  test('a recovered failure beside a real one reports only the real one', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', createInput, eventNotFound);
    ledger.record('create_event', createInput, created);
    ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
    expect(receipt(ledger, secretaryContext('ru')).evidence?.split('\n')).toEqual([
      'Создано: событие «Board games» (сегодня, 17:00), календарь: Olga.',
      'Приглашение на «Board games» не отправлено: Friend.',
      'Скажи, что повторить: уже выполненное я повторять не буду.',
    ]);
  });

  test('a create of a different event does not erase a failed create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', createInput, eventNotFound);
    ledger.record('create_event', { ...createInput, title: 'Other' }, created);
    expect(receipt(ledger, secretaryContext('ru')).evidence).toContain(
      'Не создано: событие «Board games» (сегодня, 17:00)',
    );
  });
});

describe('an unknown result', () => {
  test('is neither a failure nor a success, and asks to check before repeating', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', createInput, uncertain);
    expect(receipt(ledger, secretaryContext('ru')).evidence?.split('\n')).toEqual([
      'Не удалось подтвердить создание: событие «Board games» (сегодня, 17:00), календарь: Olga.',
      'Проверь календарь, прежде чем повторять: сам я ничего не повторяю.',
    ]);
    expect(receipt(ledger, secretaryContext('en')).evidence?.split('\n')).toEqual([
      'Could not confirm creation: event “Board games” (today, 17:00), calendar: Olga.',
      'Check the calendar before repeating anything; I never repeat a request on my own.',
    ]);
  });

  test('a retry that worked still carries a duplicate check', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', createInput, uncertain);
    ledger.record('create_event', createInput, created);
    const plan = receipt(ledger, secretaryContext('ru'));
    expect(plan.guarded).toBe(true);
    expect(plan.evidence?.split('\n')).toEqual([
      'Создано: событие «Board games» (сегодня, 17:00), календарь: Olga.',
      'Повторная попытка удалась, но первая могла тоже сработать: проверь календарь на дубль.',
    ]);
  });

  test('a retried invitation after an unknown result carries the duplicate check too', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const sent: Recorded = {
      success: true,
      disposition: 'executed',
      mutationState: 'confirmed',
      effect: { kind: 'invitation', delivery: 'delivered' },
    };
    ledger.record('send_invitation', { event_id: 1, invitee_id: FRIEND }, uncertain);
    ledger.record('send_invitation', { event_id: 1, invitee_id: FRIEND }, sent);
    const evidence = receipt(ledger, secretaryContext('en')).evidence ?? '';
    expect(evidence).toContain('check the calendar for a duplicate');
  });
});

describe('delivered through a real agent run', () => {
  test('the user reads the receipt, not the model claiming every invitation went out', async () => {
    const { db, ctx, config, sender } = createAgentRunFixture();
    setupInvitations(db, ctx);
    ctx.user = { ...ctx.user, language: 'ru' };
    const delivered: string[] = [];
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered.push(text);
    };
    const missing = 99_999;
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'create',
        name: 'create_event',
        input: { title: 'Board games', start_at: '2026-10-31T17:00:00Z' },
      },
      {
        kind: 'tool',
        callId: 'i1',
        name: 'send_invitation',
        input: { event_id: missing, invitee_username: 'sam_demo' },
      },
      { kind: 'tool', callId: 'i2', name: 'send_invitation', input: { event_id: missing, invitee_id: FRIEND } },
      { kind: 'tool', callId: 'i3', name: 'send_invitation', input: { event_id: missing, invitee_id: STRANGER } },
      { kind: 'text', text: 'Готово, всех пригласил.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    const text = result.responseText;
    expect(text).toContain('Создано: событие «Board games» (сегодня, 17:00).');
    expect(text).toContain('Приглашения на событие не отправлены: @sam_demo и ещё 2 человека.');
    expect(text).toContain('Скажи, что повторить');
    expect(text).not.toContain('всех пригласил');
    expect(text).not.toMatch(/Попытк|попытк|#\d/);
    expect(delivered.at(-1)).toContain('Создано: событие «Board games»');
  });
});

describe('the requester timezone reaches the ledger through a real agent run', () => {
  test('a rejected all-day create for another local day stays visible', async () => {
    const { ctx, config, sender } = createAgentRunFixture();
    ctx.user = { ...ctx.user, language: 'en', timezone: 'Europe/Belgrade' };
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'a',
        name: 'create_event',
        input: { title: 'Board games', start_at: '2030-04-14', all_day: true, end_at: 'invalid' },
      },
      {
        kind: 'tool',
        callId: 'b',
        name: 'create_event',
        input: { title: 'Board games', start_at: '2030-04-14T22:00:00Z', all_day: true },
      },
      { kind: 'text', text: 'Both done.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(result.responseText).toContain('Not created: event “Board games” (April 14)');
    expect(result.responseText).toContain('Created: event “Board games” (April 15)');
  });
});

describe('an invitation effect without a parsable invitee', () => {
  const resend = (delivery: 'delivered' | 'manual_forward' | 'failed'): Recorded => ({
    success: true,
    disposition: 'executed',
    mutationState: 'confirmed',
    effect: { kind: 'invitation', delivery },
  });

  test.each([
    ['failed', 'ru', 'Приглашение создано, но не доставлено.'],
    ['failed', 'en', 'Invitation created; not delivered.'],
    ['manual_forward', 'ru', 'Перешли ссылку из личного чата'],
    ['manual_forward', 'en', 'forward the link'],
  ] as const)('resend_invitation %s (%s) is never reported as a plain success', (delivery, language, expected) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('resend_invitation', { invitation_id: 41 }, resend(delivery));
    const plan = receipt(ledger, secretaryContext(language));
    expect(plan.guarded).toBe(true);
    expect(plan.evidence).toContain(expected);
    expect(plan.evidence).not.toMatch(/Выполнено|Done:|#\d|41/);
  });

  test('a delivered resend does not guard', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('resend_invitation', { invitation_id: 41 }, resend('delivered'));
    expect(receipt(ledger, secretaryContext('ru'))).toEqual({
      evidence: null,
      silent: false,
      validationNotice: null,
      guarded: false,
      interrupted: false,
    });
  });

  test('a send_invitation whose invitee cannot be read is told as undelivered, not as a done change', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: '!!!' }, resend('failed'));
    const evidence = receipt(ledger, secretaryContext('en')).evidence ?? '';
    expect(evidence).toContain('Invitation created; not delivered.');
    expect(evidence).not.toContain('Done:');
  });
});

describe('a receipt never throws, whatever the model put in the request', () => {
  const rejectedCreate = (startAt: unknown, allDay: boolean) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { title: 'Hostile', start_at: startAt, all_day: allDay }, eventNotFound);
    return ledger;
  };

  const startValues: readonly unknown[] = [
    '01/01/2030',
    'Jan 5 2030 10:00',
    '2030-02-31',
    '2030-02-31T10:00:00Z',
    '2030-13-45T99:99:99Z',
    '+275760-09-13T00:00:00Z',
    '-271821-04-20T00:00:00Z',
    '12345',
    '9'.repeat(400),
    '',
    '   ',
    'not a date',
    'T',
    12_345,
    Number.NaN,
    null,
    undefined,
    {},
    ['2030-01-01'],
    Symbol.for('start'),
  ];

  test.each(
    startValues.flatMap((start) => [false, true].map((allDay) => [start, allDay] as const)),
  )('start_at %p (all day: %p) leaves the event named without a day or time', (start, allDay) => {
    const view = receiptView(secretaryContext('en'));
    const notice = rejectedCreate(start, allDay).finalNotice(view);
    expect(notice).toContain('Not created: event “Hostile”');
    expect(notice).not.toMatch(/Invalid|NaN|undefined|\[object/);
  });

  test.each(['Bad/Zone', ''])('timezone %p omits the day and time instead of throwing', (timezone) => {
    const view = { ...receiptView(secretaryContext('ru')), timezone };
    const notice = rejectedCreate('2030-01-01T10:00:00Z', false).finalNotice(view);
    expect(notice).toContain('Не создано: событие «Hostile» — ничего не изменилось.');
    expect(notice).not.toMatch(/2030|января|\(/);
  });

  test('a bad timezone does not stop an event the run has seen from being named', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', createInput, created);
    ledger.record('delete_event', { event_id: 501 }, eventNotFound);
    const view = { ...receiptView(secretaryContext('en')), timezone: 'Bad/Zone' };
    expect(ledger.finalNotice(view)).toContain('Not deleted: event “Board games”');
  });

  test('a valid ISO start still names the local day and time', () => {
    const view = receiptView(secretaryContext('en'));
    expect(rejectedCreate('2026-11-05T09:00:00Z', false).finalNotice(view)).toContain(
      'Not created: event “Hostile” (November 5, 09:00)',
    );
  });
});

/** Telegram HTML as this bot sends it: only <b>, <i> and <code>, properly nested; every other `<` and `&` escaped. */
function isValidTelegramHtml(html: string): boolean {
  const open: string[] = [];
  for (const match of html.matchAll(/<(\/?)(b|i|code)>|[<>]|&(?!(?:amp|lt|gt|quot);)/g)) {
    const [, closing, tag] = match;
    if (tag === undefined) return false;
    if (closing === '') open.push(tag);
    else if (open.pop() !== tag) return false;
  }
  return open.length === 0;
}

describe('model- and user-controlled names are inert in the delivered message', () => {
  /** [what the model or user wrote, what the reader sees]. */
  const hostile = [
    ['A <b & c', 'A <b & c'],
    ['*bold*', '∗bold∗'],
    ['_it_', '＿it＿'],
    ['`code`', 'ˋcodeˋ'],
    ['[x](http://evil)', '[x](http://evil)'],
    ['_x **y_ z**', '＿x ∗∗y＿ z∗∗'],
    ['**a** and _b_ and `c`', '∗∗a∗∗ and ＿b＿ and ˋcˋ'],
    ['two\nlines\n\nCreated: fake', 'two lines Created: fake'],
  ] as const;

  const carriers = {
    title: (name: string) => ({
      ledger: () => {
        const ledger = new WriteOutcomes(WRITE_TOOLS);
        ledger.record('create_event', { title: name, start_at: '2026-10-31T17:00:00Z' }, eventNotFound);
        return ledger;
      },
      names: {},
    }),
    contact: (name: string) => ({
      ledger: () => {
        const ledger = new WriteOutcomes(WRITE_TOOLS);
        ledger.record('create_event', createInput, created);
        ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
        return ledger;
      },
      names: { friend: name },
    }),
    owner: (name: string) => ({
      ledger: () => {
        const ledger = new WriteOutcomes(WRITE_TOOLS);
        ledger.record('create_event', { ...createInput, title: 'Plain' }, eventNotFound);
        return ledger;
      },
      names: { owner: name },
    }),
  };

  describe.each(Object.entries(carriers))('in a %s', (carrier, carry) => {
    test.each(hostile)('%j is rendered as plain text and valid Telegram HTML', (written, seen) => {
      const { ledger, names } = carry(written);
      const evidence = receipt(ledger(), secretaryContext('en', false, names)).evidence ?? '';
      const html = markdownToHtml(evidence);
      expect(isValidTelegramHtml(html)).toBe(true);
      expect(html).not.toMatch(/<\/?(?:b|i|code|a)\b/);
      expect(stripHtml(html)).toContain(seen);
      // Only the contact carrier reports a genuine create; a title or name must never forge another line.
      expect(evidence.split('\n').filter((line) => line.startsWith('Created:'))).toHaveLength(
        carrier === 'contact' ? 1 : 0,
      );
    });
  });

  test('an @username keeps its inner underscores but cannot open emphasis at its edges', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'john_smith' }, eventNotFound);
    ledger.record('send_invitation', { event_id: 501, invitee_username: '_a_' }, eventNotFound);
    const html = markdownToHtml(receipt(ledger, secretaryContext('en')).evidence ?? '');
    expect(isValidTelegramHtml(html)).toBe(true);
    expect(html).not.toMatch(/<\/?(?:b|i|code|a)\b/);
    expect(stripHtml(html)).toContain('@john_smith');
  });
});

describe('all-day days west of UTC come from the written start, not the summary', () => {
  const allDay = { title: 'Board games', start_at: '2030-04-15', all_day: true };
  const rejected: Recorded = { success: false, disposition: 'failed', mutationState: 'not_applied', error: 'bad' };

  function resultFor(timezone: string): Recorded {
    const summary = eventToSummary(
      { id: 501, title: 'Board games', start_at: '2030-04-15T00:00:00.000Z', all_day: 1 } as unknown as Parameters<
        typeof eventToSummary
      >[0],
      timezone,
    );
    return { success: true, disposition: 'executed', mutationState: 'confirmed', data: summary };
  }

  function receiptIn(timezone: string, failedFirst: boolean): string {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    if (failedFirst) ledger.record('create_event', { ...allDay }, rejected, false, timezone);
    ledger.record('create_event', allDay, resultFor(timezone), false, timezone);
    ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
    const view = { ...receiptViewFor('en'), timezone, now: new Date('2030-04-01T09:00:00Z') };
    return ledger.finalNotice(view) ?? '';
  }

  test.each(['America/New_York', 'Europe/Belgrade'])('%s: created on April 15', (timezone) => {
    for (const failedFirst of [false, true]) {
      const text = receiptIn(timezone, failedFirst);
      expect(text).toContain('Created: event “Board games” (April 15).');
      expect(text).not.toContain('April 14');
    }
  });

  test('a read after the create does not bring the shifted day back', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const tz = 'America/New_York';
    ledger.record('create_event', allDay, resultFor(tz), false, tz);
    ledger.record('get_event', { event_id: 501 }, resultFor(tz), false, tz);
    ledger.record('get_events', {}, resultFor(tz), false, tz);
    ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
    const view = { ...receiptViewFor('en'), timezone: tz, now: new Date('2030-04-01T09:00:00Z') };
    expect(ledger.finalNotice(view)).toContain('(April 15)');
  });

  test('west of UTC a read of an all-day event never names its shifted day, even before a failed delete', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const tz = 'America/New_York';
    ledger.record('get_event', { event_id: 501 }, resultFor(tz), false, tz);
    ledger.record('delete_event', { event_id: 501 }, { ...eventNotFound }, false, tz);
    const view = { ...receiptViewFor('en'), timezone: tz, now: new Date('2030-04-01T09:00:00Z') };
    const text = ledger.finalNotice(view) ?? '';
    expect(text).toContain('Not deleted: event “Board games”');
    expect(text).not.toContain('April 14');
  });

  test('an all-day event the run never created is not told on a day derived from a shifted summary', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const tz = 'America/New_York';
    ledger.record('update_event', { event_id: 501, description: 'x' }, resultFor(tz), false, tz);
    ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
    const view = { ...receiptViewFor('en'), timezone: tz, now: new Date('2030-04-01T09:00:00Z') };
    expect(ledger.finalNotice(view)).not.toContain('April 14');
  });
});

describe('a create folded into a moved or renamed event', () => {
  const updated: Recorded = {
    success: true,
    disposition: 'executed',
    mutationState: 'confirmed',
    data: { id: 501, title: 'Board games', date: '2026-10-31', time: '11:00', all_day: false },
  };

  const result = (data: { title?: string; all_day?: boolean }): Recorded => ({
    ...updated,
    data: { id: 501, title: 'Board games', date: '2026-10-31', time: '11:00', all_day: false, ...data },
  });
  test.each([
    ['start_at', { event_id: 501, start_at: '2026-10-31T11:00:00Z' }, updated],
    ['title', { event_id: 501, title: 'Chess' }, result({ title: 'Chess' })],
    ['all_day', { event_id: 501, all_day: true }, result({ all_day: true })],
    ['recurrence_rule', { event_id: 501, recurrence_rule: 'FREQ=DAILY;COUNT=2' }, updated],
  ])('a failed new create after update_event changed %s stays visible', (_field, input, outcome) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Board games', start_at: '2026-10-31T10:00:00Z' },
      { ...created, data: { id: 501, title: 'Board games', date: '2026-10-31', time: '10:00', all_day: false } },
    );
    ledger.record('update_event', input, outcome);
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T10:00:00Z' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Board games”');
  });

  test('an update that restates the same title and start leaves the create standing', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Board games', start_at: '2026-10-31T10:00:00Z' },
      { ...created, data: { id: 501, title: 'Board games', date: '2026-10-31', time: '10:00', all_day: false } },
    );
    ledger.record(
      'update_event',
      { event_id: 501, title: ' board  GAMES ', start_at: '2026-10-31T12:00:00+02:00' },
      updated,
    );
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T10:00:00Z' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('an update whose confirmed result is all-day retires the timed create, whatever spelling the input used', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Board games', start_at: '2026-10-31T10:00:00Z' },
      { ...created, data: { id: 501, title: 'Board games', date: '2026-10-31', time: '10:00', all_day: false } },
    );
    ledger.record(
      'update_event',
      { event_id: 501, all_day: 'false' },
      { ...updated, data: { id: 501, title: 'Board games', date: '2026-10-31', all_day: true } },
    );
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T10:00:00Z' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  test('a snooze moves the start, so a failed create at the old start stays visible', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Board games', start_at: '2026-10-31T10:00:00Z' },
      { ...created, data: { id: 501, title: 'Board games', date: '2026-10-31', time: '10:00', all_day: false } },
    );
    ledger.record(
      'snooze_event',
      { event_id: 501, minutes: 15 },
      { success: true, disposition: 'executed', mutationState: 'confirmed' },
    );
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T10:00:00Z' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  test('an unknown update of the start retires the create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Board games', start_at: '2026-10-31T10:00:00Z' },
      { ...created, data: { id: 501, title: 'Board games', date: '2026-10-31', time: '10:00', all_day: false } },
    );
    ledger.record('update_event', { event_id: 501, start_at: '2026-10-31T11:00:00Z' }, uncertain);
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T10:00:00Z' }, rejectedCreate);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('Not created');
    expect(text).toContain('Created: event “Board games” (today, 10:00).');
  });

  test('an unknown delete retires the create: a failed re-create stays visible', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Board games', start_at: '2026-10-31T10:00:00Z' },
      { ...created, data: { id: 501, title: 'Board games', date: '2026-10-31', time: '10:00', all_day: false } },
    );
    ledger.record('delete_event', { event_id: 501 }, uncertain);
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T10:00:00Z' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  test('an unknown snooze retires the create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Board games', start_at: '2026-10-31T10:00:00Z' },
      { ...created, data: { id: 501, title: 'Board games', date: '2026-10-31', time: '10:00', all_day: false } },
    );
    ledger.record('snooze_event', { event_id: 501, minutes: 15 }, uncertain);
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T10:00:00Z' }, rejectedCreate);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('Not created');
    expect(text).toContain('Created: event “Board games” (today, 10:00).');
  });

  test('an unknown update that changes only details retires the create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Board games', start_at: '2026-10-31T10:00:00Z' },
      { ...created, data: { id: 501, title: 'Board games', date: '2026-10-31', time: '10:00', all_day: false } },
    );
    ledger.record('update_event', { event_id: 501, location: 'Room 5' }, uncertain);
    ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T10:00:00Z' }, rejectedCreate);
    expect(ledger.finalNotice({ ...receiptViewFor('en'), now: new Date('2026-10-31T08:00:00Z') })).toContain(
      'Created: event “Board games” (today, 10:00)',
    );
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Board games”');
  });

  test('an update of another field leaves the create standing, so a failed duplicate adds nothing', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Board games', start_at: '2026-10-31T10:00:00Z' },
      { ...created, data: { id: 501, title: 'Board games', date: '2026-10-31', time: '10:00', all_day: false } },
    );
    ledger.record('update_event', { event_id: 501, category: 'work' }, updated);
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T10:00:00Z' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });
});

describe('two invitees with the same display name', () => {
  test('are both accounted for', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
    ledger.record('send_invitation', { event_id: 501, invitee_id: STRANGER }, eventNotFound);
    // Different Telegram ids whose labels read alike: nobody may disappear from the line.
    const view = { ...receiptViewFor('en'), personLabel: () => 'Friend' };
    const line = ledger.finalNotice(view)?.split('\n')[0] ?? '';
    expect(line).toContain('not sent: Friend and 1 more.');
  });
});

describe('an invitee typed in several ways is one write', () => {
  const delivered: Recorded = exec({ effect: { kind: 'invitation', delivery: 'delivered' } });
  const spellings = ['bob', '@bob', 'Bob', ' bob', '@BOB '];

  test.each(spellings)('rejected as "bob", then delivered as %j: nothing contradicts', (retry) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, eventNotFound);
    ledger.record('send_invitation', { event_id: 501, invitee_username: retry }, delivered);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test.each(spellings)('unknown as "bob", then delivered as %j: one duplicate check, no unknown line', (retry) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, uncertain);
    ledger.record('send_invitation', { event_id: 501, invitee_username: retry }, delivered);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('the first try may have gone through too');
    expect(text).not.toContain('Could not confirm');
  });

  test.each(
    spellings.slice(1),
  )('delivered as "bob", then refused as %j: both outcomes stay told, the delivery is not overwritten', (again) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    ledger.record('send_invitation', { event_id: 501, invitee_username: again }, eventNotFound);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('was sent: @bob.');
    expect(text).toContain('was not sent: @bob.');
  });

  test('delivered, then unknown on a repeat: the delivery stays, the repeat is unconfirmed', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    ledger.record('send_invitation', { event_id: 501, invitee_username: '@bob' }, uncertain);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('was sent: @bob.');
    expect(text).toContain('Could not confirm that the invitation');
  });

  test('delivered, then a skipped repeat: nothing to report', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    ledger.record(
      'send_invitation',
      { event_id: 501, invitee_username: 'bob' },
      { success: false, disposition: 'skipped' },
    );
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('delivered, refused, delivered again: nothing to report', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    ledger.record('send_invitation', { event_id: 501, invitee_username: '@bob' }, eventNotFound);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'Bob' }, delivered);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('delivered, unknown, delivered again: the duplicate check, no unknown line', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    ledger.record('send_invitation', { event_id: 501, invitee_username: '@bob' }, uncertain);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'Bob' }, delivered);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('the first try may have gone through too');
    expect(text).not.toContain('Could not confirm');
  });

  test('unknown, delivered as @bob, delivered again as Bob: the duplicate check is kept', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, uncertain);
    ledger.record('send_invitation', { event_id: 501, invitee_username: '@bob' }, delivered);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'Bob' }, delivered);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('the first try may have gone through too');
  });

  test('delivered, then a repeat that only created the invitation: the delivery stays, the other is told beside', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    ledger.record(
      'send_invitation',
      { event_id: 501, invitee_username: '@bob' },
      exec({ effect: { kind: 'invitation', delivery: 'failed' } }),
    );
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('was sent: @bob.');
    expect(text).toContain('was created but not delivered: @bob.');
  });

  test('delivered, unknown, then created but not delivered: the duplicate warning is kept', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    ledger.record('send_invitation', { event_id: 501, invitee_username: '@bob' }, uncertain);
    ledger.record(
      'send_invitation',
      { event_id: 501, invitee_username: 'Bob' },
      exec({ effect: { kind: 'invitation', delivery: 'failed' } }),
    );
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('was created but not delivered: @bob.');
    expect(text).toContain('the first try may have gone through too');
  });

  test('delivered, unknown, created but not delivered, delivered again: the duplicate warning survives', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const created = exec({ effect: { kind: 'invitation', delivery: 'failed' } });
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    ledger.record('send_invitation', { event_id: 501, invitee_username: '@bob' }, uncertain);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'Bob' }, created);
    ledger.record('send_invitation', { event_id: 501, invitee_username: ' bob' }, delivered);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('the first try may have gone through too');
  });

  test('delivered, unknown, created but not delivered twice: the duplicate warning survives', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const created = exec({ effect: { kind: 'invitation', delivery: 'failed' } });
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    ledger.record('send_invitation', { event_id: 501, invitee_username: '@bob' }, uncertain);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'Bob' }, created);
    ledger.record('send_invitation', { event_id: 501, invitee_username: ' bob' }, created);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('the first try may have gone through too');
  });

  test('delivered, created but not delivered, then refused: the second invitation stays told', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    ledger.record(
      'send_invitation',
      { event_id: 501, invitee_username: '@bob' },
      exec({ effect: { kind: 'invitation', delivery: 'failed' } }),
    );
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'Bob' }, eventNotFound);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('was created but not delivered: @bob.');
  });

  test('unknown, then refused: the unknown stays the open question', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, uncertain);
    ledger.record('send_invitation', { event_id: 501, invitee_username: '@bob' }, eventNotFound);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('Could not confirm that the invitation');
  });

  test('a zero invitee_id is no id: the same person as the username alone', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_id: 0, invitee_username: 'bob' }, eventNotFound);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('delivered, cancelled, then refused: the refusal is told', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    ledger.record('cancel_invitation', { invitation_id: 1 }, exec());
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, eventNotFound);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('was not sent: @bob.');
  });

  test('a null invitee_id does not make two usernames one invitee', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_id: null, invitee_username: 'alice' }, eventNotFound);
    ledger.record('send_invitation', { event_id: 501, invitee_id: null, invitee_username: 'bob' }, delivered);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('was not sent: @alice.');
  });

  test('two different people stay two writes', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bob' }, delivered);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'bobby' }, eventNotFound);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('was not sent: @bobby');
  });
});

describe('one contact named in several ways is one person', () => {
  test('username casing and username plus id are the same invitee', () => {
    const ctx = secretaryContext('en');
    ctx.contactRepo?.upsert(SECRETARY, 'Pal', 'pal_demo', 3055);
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'pal_demo' }, eventNotFound);
    ledger.record('send_invitation', { event_id: 501, invitee_username: 'PAL_DEMO' }, eventNotFound);
    ledger.record('send_invitation', { event_id: 501, invitee_id: 3055 }, eventNotFound);
    const line = receipt(ledger, ctx).evidence?.split('\n')[0] ?? '';
    expect(line).toContain('not sent: Pal.');
  });
});

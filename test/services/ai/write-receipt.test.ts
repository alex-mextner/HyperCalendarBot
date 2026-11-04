/**
 * What the user reads when a run had failed or skipped writes: the evidence guard's receipt.
 * Built on the real WriteOutcomes and planGuard with synthetic ids (secretary 1001, calendar owner
 * 2002, invitees 3001/3002); the incident is a secretary creating an event in the owner's calendar
 * whose three invitations were then all rejected.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { CalendarProposalRepository } from '../../../src/database/repositories/calendar-proposal.repository.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { SecretaryRepository } from '../../../src/database/repositories/secretary.repository.ts';
import type { ToolRunLedger } from '../../../src/services/ai/agent/tool-round.ts';
import { planGuard } from '../../../src/services/ai/agent/turn-finish.ts';
import { createTurnState } from '../../../src/services/ai/agent/turn-state.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { WRITE_TOOLS } from '../../../src/services/ai/tool-executor.ts';
import { eventToSummary, occurrenceToSummary } from '../../../src/services/ai/tool-handlers/events/presentation.ts';
import type { AgentContext, ToolResult } from '../../../src/services/ai/types.ts';
import { WriteOutcomes } from '../../../src/services/ai/write-outcomes.ts';
import { receiptView } from '../../../src/services/ai/write-receipt.ts';
import { markdownToHtml, stripHtml } from '../../../src/utils/telegram.ts';
import { createAgentRunFixture, makeStreamImpl, setupInvitations } from './agent-run-helpers.ts';

const SECRETARY = 1001;
const OWNER = 2002;
const FRIEND = 3001;
const STRANGER = 3002;

type Recorded = ToolResult & { disposition: 'executed' | 'failed' | 'skipped' };

const created: Recorded = {
  success: true,
  disposition: 'executed',
  mutationState: 'confirmed',
  data: { id: 501, title: 'Board games', date: '2026-10-31', time: '17:00', all_day: false },
};
const eventNotFound: Recorded = {
  success: false,
  disposition: 'failed',
  mutationState: 'not_applied',
  error: 'Event not found',
};
const rejectedCreate: Recorded = {
  success: false,
  disposition: 'failed',
  mutationState: 'not_applied',
  error: 'bad end_at',
};
const exec = (extra: Partial<Recorded> = {}): Recorded => ({
  success: true,
  disposition: 'executed',
  mutationState: 'confirmed',
  ...extra,
});
const okCall = exec({ data: { id: 601, title: 'Call', date: '2026-10-31', time: '10:00', all_day: false } });
const uncertain: Recorded = { success: false, disposition: 'failed', mutationState: 'uncertain', error: 'timeout' };
const createInput = {
  title: 'Board games',
  start_at: '2026-10-31T17:00:00Z',
  end_at: '2026-10-31T18:00:00Z',
  owner_id: OWNER,
  scope: 'personal',
};

function ledgerWith(writeOutcomes: WriteOutcomes): ToolRunLedger {
  return { allToolCalls: [], allToolResults: [], toolEvidence: [], seenToolCallKeys: new Set(), writeOutcomes };
}

interface Names {
  owner?: string | null;
  friend?: string;
  /** The delegation the secretary holds: active (default), revoked, or never granted. */
  access?: 'revoked' | 'none';
}

/** A secretary (1001) whose active write access covers the owner's calendar (2002, "Olga"). */
function secretaryContext(language: 'ru' | 'en', isGroup = false, names: Names = {}): AgentContext {
  const { db, ctx } = createAgentRunFixture();
  ctx.userRepo.create({ telegram_id: SECRETARY, first_name: 'Kim', timezone: 'UTC', language });
  ctx.userRepo.create({
    telegram_id: OWNER,
    first_name: names.owner === undefined ? 'Olga' : (names.owner ?? undefined),
    timezone: 'UTC',
    language,
  });
  const contactRepo = new ContactRepository(db);
  contactRepo.upsert(SECRETARY, names.friend ?? 'Friend', undefined, FRIEND);
  const secretaryRepo = new SecretaryRepository(db);
  if (names.access !== 'none') {
    const record = secretaryRepo.upsert({ owner_id: OWNER, secretary_id: SECRETARY, permission: 'write' });
    secretaryRepo.updateStatus(record.id, names.access === 'revoked' ? 'revoked' : 'active');
  }
  const user = ctx.userRepo.findByTelegramId(SECRETARY);
  if (!user) throw new Error('secretary was not created');
  return {
    ...ctx,
    user,
    contactRepo,
    isGroup,
    secretary: { secretaryRepo, secretaryForLine: undefined, calendarProposalRepo: new CalendarProposalRepository(db) },
  };
}

function receipt(ledger: WriteOutcomes, ctx: AgentContext) {
  const state = createTurnState();
  state.termination = 'normal';
  return planGuard(ctx, state, false, ledgerWith(ledger));
}

/** The incident: one create in the owner's calendar, then three invitations the account cannot see. */
function incident(): WriteOutcomes {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('create_event', createInput, created);
  ledger.record('send_invitation', { event_id: 501, invitee_username: 'sam_demo' }, eventNotFound);
  ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
  ledger.record('send_invitation', { event_id: 501, invitee_id: STRANGER }, eventNotFound);
  return ledger;
}

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
    expect(plan).toEqual({ evidence: null, silent: false, validationNotice: null, guarded: false });
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

describe('ledger identity and dates (regressions)', () => {
  const deleted: Recorded = {
    success: true,
    disposition: 'executed',
    mutationState: 'confirmed',
    effect: { kind: 'event_deleted' },
  };
  const personal = { title: 'Board games', start_at: '2026-10-31T17:00:00Z' };

  test('a failed recreation stays visible after the earlier create was deleted', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', personal, created);
    ledger.record('delete_event', { event_id: 501 }, deleted);
    ledger.record('create_event', personal, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Board games”');
  });

  test('declining an event (attendance_declined) does not retire the create of that event', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', personal, created);
    ledger.record('delete_event', { event_id: 501 }, { ...deleted, effect: { kind: 'attendance_declined' } });
    ledger.record('create_event', personal, rejectedCreate);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).not.toContain('Not created');
  });

  test('an impossible calendar date is not turned into another day', () => {
    for (const allDay of [true, false]) {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', { title: 'Board games', start_at: '2030-02-31', all_day: allDay }, rejectedCreate);
      const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
      expect(text).toContain('Not created: event “Board games”');
      expect(text).not.toMatch(/March|00:00/);
    }
  });

  test('an extra event_id in a create input does not rename the created event', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...personal, event_id: 777 }, created);
    ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('Created: event “Board games”');
    expect(text).toContain('The invitation to “Board games” was not sent');
  });

  test('listing the occurrences of a created series keeps the created day', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const series: Recorded = {
      ...created,
      data: { id: 502, title: 'Board games', date: '2026-04-15', time: '17:00', all_day: false },
    };
    ledger.record(
      'create_event',
      { ...personal, start_at: '2026-04-15T17:00:00Z', recurrence_rule: 'FREQ=DAILY;COUNT=3' },
      series,
    );
    const read: Recorded = {
      success: true,
      disposition: 'executed',
      data: {
        id: 502,
        title: 'Board games',
        date: '2026-04-17',
        time: '17:00',
        all_day: false,
        recurrence_rule: 'FREQ=DAILY;COUNT=3',
      },
    };
    ledger.record('get_events', {}, read);
    ledger.record('send_invitation', { event_id: 502, invitee_id: FRIEND }, eventNotFound);
    const text = ledger.finalNotice({ ...receiptViewFor('en'), now: new Date('2026-04-14T09:00:00Z') }) ?? '';
    expect(text).toContain('tomorrow, 17:00');
    expect(text).not.toContain('April 17');
  });

  test('all_day "false" is not all-day: the string and the boolean form are the same create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...personal, all_day: 'false', end_at: 'invalid' }, rejectedCreate);
    ledger.record('create_event', { ...personal, all_day: false }, created);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('a failed all-day create is not hidden by a timed create at the same instant', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...personal, all_day: 'true' }, rejectedCreate);
    ledger.record('create_event', { ...personal, all_day: false }, created);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  // Reachable all-day spellings of one date (start_at accepts YYYY-MM-DD and any offset instant): the
  // date-only form and 'T00:00:00Z' are one UTC midnight; a zone ahead of UTC adds the local midnight
  // expressed in UTC. The bot reads all three as the same calendar day (allDayCalendarDate), so a
  // reject-then-retry using two of them is one event and must not read "Not created" plus "Created".
  describe('one-off all-day creates are one event when they name the same calendar day', () => {
    const tz = 'Europe/Belgrade';
    const dayOf = (id: number, date: string): Recorded => ({
      ...created,
      data: { id, title: 'Board games', date, all_day: true },
    });
    const allDay = (start_at: string, extra: object = {}) => ({
      title: 'Board games',
      all_day: true,
      start_at,
      ...extra,
    });
    const spellings = ['2030-04-15', '2030-04-15T00:00:00Z', '2030-04-14T22:00:00Z', '2030-04-15T00:00:00+02:00'];

    test.each(
      spellings.flatMap((a) => spellings.map((b) => [a, b] as const)),
    )('reject %s, then create %s', (rejected, retried) => {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', allDay(rejected, { end_at: 'invalid' }), rejectedCreate, false, tz);
      ledger.record('create_event', allDay(retried), dayOf(503, '2030-04-15'), false, tz);
      expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
    });

    test('a created all-day event absorbs a rejected retry in another spelling', () => {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', allDay('2030-04-14T22:00:00Z'), dayOf(503, '2030-04-15'), false, tz);
      ledger.record('create_event', allDay('2030-04-15'), rejectedCreate, false, tz);
      expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
    });

    test('an impossible date is never rolled into a real day to match another create', () => {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', allDay('2030-02-31T23:00:00Z'), rejectedCreate, false, tz);
      ledger.record('create_event', allDay('2030-03-04'), dayOf(503, '2030-03-04'), false, tz);
      expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
    });

    test('another calendar day stays a separate, visible failure', () => {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', allDay('2030-04-16', {}), rejectedCreate, false, tz);
      ledger.record('create_event', allDay('2030-04-14T22:00:00Z'), dayOf(503, '2030-04-15'), false, tz);
      expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
    });

    test('recurring all-day spellings stay distinct: a series expands from its start instant', () => {
      const rule = { recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=2' };
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', allDay('2030-04-14T22:00:00Z', rule), dayOf(504, '2030-04-16'), false, tz);
      ledger.record('create_event', allDay('2030-04-15', rule), rejectedCreate, false, tz);
      expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
    });

    test('a timed create at the same instant is a different event from the all-day one', () => {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', allDay('2030-04-15'), rejectedCreate, false, tz);
      ledger.record(
        'create_event',
        { title: 'Board games', start_at: '2030-04-15' },
        dayOf(505, '2030-04-15'),
        false,
        tz,
      );
      expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
    });
  });

  test('a rejected all-day create shows the calendar day the handler stores, not the UTC day', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Board games', start_at: '2030-04-14T22:00:00Z', all_day: true },
      rejectedCreate,
    );
    const view = { ...receiptViewFor('en'), timezone: 'Europe/Belgrade', now: new Date('2030-04-01T09:00:00Z') };
    expect(ledger.finalNotice(view)).toContain('April 15');
  });

  test('a timed date-only start is read as the UTC instant the handler stores, in the user zone', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { title: 'Board games', start_at: '2030-04-15' }, rejectedCreate);
    const view = { ...receiptViewFor('en'), timezone: 'America/New_York', now: new Date('2030-04-01T09:00:00Z') };
    expect(ledger.finalNotice(view)).toContain('April 14, 20:00');
  });

  test('a long name is cut by code point, never through a surrogate pair', () => {
    const ctx = secretaryContext('en', false, { friend: `${'a'.repeat(39)}😀tail` });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
    const text = receipt(ledger, ctx).evidence ?? '';
    expect(text).toContain(`${'a'.repeat(39)}😀`);
    expect(text.isWellFormed()).toBe(true);
  });
});

function receiptViewFor(language: 'ru' | 'en') {
  return receiptView(secretaryContext(language));
}

describe('a repeated create that ends unknown (exact texts)', () => {
  const req = { title: 'Board games', start_at: '2026-10-31T17:00:00Z' };
  const ru =
    'Повторное создание не удалось подтвердить: событие «Board games» (сегодня, 17:00). Проверь календарь на дубль.';
  const en =
    'A repeat of the creation could not be confirmed: event “Board games” (today, 17:00). Check the calendar for a duplicate.';
  const first = 'Повторная попытка удалась, но первая могла тоже сработать: проверь календарь на дубль.';
  const firstEn = 'The retry worked, but the first try may have gone through too: check the calendar for a duplicate.';

  test('success, then an unknown repeat: the repeat is the unconfirmed one', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', req, created);
    ledger.record('create_event', req, uncertain);
    const lines = (lang: 'ru' | 'en') =>
      ledger.finalNotice({ ...receiptViewFor(lang), now: new Date('2026-10-31T08:00:00Z') })?.split('\n') ?? [];
    expect(lines('en')).toContain(en);
    expect(lines('en')).not.toContain(firstEn);
    expect(lines('ru')).toContain(ru);
    expect(lines('ru')).not.toContain(first);
  });
});

describe('the create key covers end, location and description', () => {
  const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z', end_at: '2026-10-31T10:30:00Z' };

  test.each([
    ['end_at', { end_at: '2026-10-31T11:00:00Z' }],
    ['location', { location: 'Office' }],
    ['description', { description: 'Agenda' }],
  ])('a failed create that differs in %s stays visible', (_field, other) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, ...other }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Call”');
  });

  test('absent, empty and blank location or description are the same create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: '  ', description: '' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('an update that changes the location retires the create; one that restates it does not', () => {
    const base = { ...call, location: 'Office' };
    const changed = new WriteOutcomes(WRITE_TOOLS);
    changed.record('create_event', base, okCall);
    changed.record('update_event', { event_id: 601, location: 'Home' }, okCall);
    changed.record('create_event', base, rejectedCreate);
    expect(changed.finalNotice(receiptViewFor('en'))).toContain('Not created');
    const same = new WriteOutcomes(WRITE_TOOLS);
    same.record('create_event', base, okCall);
    same.record('update_event', { event_id: 601, location: ' Office ' }, okCall);
    same.record('create_event', base, rejectedCreate);
    expect(same.finalNotice(receiptViewFor('en'))).toBeNull();
  });
});

describe('a corrected retry settles the rejected attempt, whatever it corrected', () => {
  const base = { title: 'Board games', start_at: '2026-10-31T17:00:00Z' };

  test.each([
    ['end_at', { end_at: 'invalid' }, { end_at: '2026-10-31T18:00:00Z' }],
    ['location', { location: 'Office' }, { location: 'office' }],
    ['description', { description: 'Bring snacks' }, { description: 'Bring drinks' }],
  ])('rejected with one %s, then created with another: no Not created line', (_field, wrong, fixed) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...base, ...wrong }, rejectedCreate);
    ledger.record('create_event', { ...base, ...fixed }, created);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });
});

describe('end spellings of one all-day date', () => {
  const tz = 'Europe/Belgrade';
  const day: Recorded = exec({ data: { id: 801, title: 'Board games', date: '2030-04-15', all_day: true } });
  const allDay = (start_at: string, end_at: string) => ({ title: 'Board games', all_day: true, start_at, end_at });

  test('a rejected repeat with the end spelled another way adds nothing', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', allDay('2030-04-14T22:00:00Z', '2030-04-14T22:00:00Z'), day, false, tz);
    ledger.record('create_event', allDay('2030-04-15', '2030-04-15'), rejectedCreate, false, tz);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('restating the end in another spelling does not retire the create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', allDay('2030-04-14T22:00:00Z', '2030-04-14T22:00:00Z'), day, false, tz);
    ledger.record('update_event', { event_id: 801, end_at: '2030-04-15' }, day, false, tz);
    ledger.record('create_event', allDay('2030-04-14T22:00:00Z', '2030-04-14T22:00:00Z'), rejectedCreate, false, tz);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });
});

describe('create identity and retirement: pinned details', () => {
  const req = { title: 'Board games', start_at: '2026-10-31T10:00:00Z' };
  const row = (id: number, title: string): Recorded =>
    exec({ data: { id, title, date: '2026-10-31', time: '10:00', all_day: false } });

  test('the calendar owner is part of the create key', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...req, owner_id: OWNER }, rejectedCreate);
    ledger.record('create_event', req, row(701, 'Board games'));
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  test('deleting another event does not retire this create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', req, row(701, 'Board games'));
    ledger.record('create_event', { title: 'Chess', start_at: '2026-10-31T12:00:00Z' }, row(702, 'Chess'));
    ledger.record('delete_event', { event_id: 702 }, exec({ effect: { kind: 'event_deleted' } }));
    ledger.record('create_event', req, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('an update whose confirmed result carries another title retires the create, whatever the input says', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', req, row(701, 'Board games'));
    ledger.record('update_event', { event_id: 701, category: 'work' }, row(701, 'Chess'));
    ledger.record('create_event', req, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });
});

describe('the duplicate warning names the repeated request, not the event as it is now', () => {
  const req = { title: 'Board games', start_at: '2026-10-31T17:00:00Z' };
  const ok = exec({ data: { id: 501, title: 'Board games', date: '2026-10-31', time: '17:00', all_day: false } });
  const view = (hide = false) => ({
    ...receiptViewFor('en'),
    hideTargets: hide,
    now: new Date('2026-10-31T08:00:00Z'),
  });

  test('an update after the repeat does not rename the event in the warning', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', req, ok);
    ledger.record('create_event', req, uncertain);
    ledger.record(
      'update_event',
      { event_id: 501, title: 'Chess', start_at: '2026-10-31T19:00:00Z' },
      exec({ data: { id: 501, title: 'Chess', date: '2026-10-31', time: '19:00', all_day: false } }),
    );
    expect(ledger.finalNotice(view())?.split('\n')).toContain(
      'A repeat of the creation could not be confirmed: event “Board games” (today, 17:00). Check the calendar for a duplicate.',
    );
  });

  test('the warning is built from the repeat itself, as it was worded', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', req, ok);
    ledger.record('create_event', { ...req, title: ' board   GAMES ' }, uncertain);
    expect(ledger.finalNotice(view())).toContain('event “board GAMES” (today, 17:00)');
  });
});

describe("an event's day and time come only from the write itself", () => {
  const seriesEvent = {
    id: 9,
    title: 'Standup',
    start_at: '2026-04-02T10:00:00.000Z',
    end_at: null,
    all_day: 0,
    recurrence_rule: 'FREQ=DAILY;COUNT=3',
  } as unknown as Parameters<typeof occurrenceToSummary>[0]['event'];
  const row = (start: string) =>
    occurrenceToSummary(
      { event: seriesEvent, occurrence_start: start, occurrence_end: null, is_exception: false },
      'UTC',
    );
  const occurrences = (): Recorded =>
    exec({ data: ['2026-04-02', '2026-04-03', '2026-04-04'].map((d) => row(`${d}T10:00:00.000Z`)) });
  const view = () => ({ ...receiptViewFor('en'), now: new Date('2026-03-01T09:00:00Z') });
  const failedUpdate = () => ({ event_id: 9, title: 'Daily' });

  test.each([
    'get_events',
    'get_upcoming',
  ])('occurrence rows of %s, then a failed update: the event is named by title alone', (read) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(read, {}, occurrences());
    ledger.record('update_event', failedUpdate(), eventNotFound);
    const text = ledger.finalNotice(view()) ?? '';
    expect(text).toContain('Not updated: event “Standup”, fields: title — nothing was changed.');
    expect(text).not.toMatch(/April|10:00/);
  });

  test.each([
    ['get_event', exec({ data: row('2026-04-02T10:00:00.000Z') })],
    ['search_events', exec({ data: [row('2026-04-02T10:00:00.000Z')] })],
  ])('the first start of a series from %s is never a day for a later failed write', (read, result) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(read, {}, result);
    ledger.record('update_event', failedUpdate(), eventNotFound);
    ledger.record('delete_event', { event_id: 9 }, eventNotFound);
    const text = ledger.finalNotice(view()) ?? '';
    expect(text).toContain('Not updated: event “Standup”');
    expect(text).toContain('Not deleted: event “Standup”');
    expect(text).not.toMatch(/April|10:00/);
  });

  test('a successful update without a start, and its summary, say nothing about the day', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('update_event', failedUpdate(), exec({ data: row('2026-04-02T10:00:00.000Z') }));
    ledger.record('send_invitation', { event_id: 9, invitee_id: FRIEND }, eventNotFound);
    const text = ledger.finalNotice(view()) ?? '';
    expect(text).toContain('Updated: event “Standup”');
    expect(text).not.toMatch(/April|10:00/);
  });

  test('a series the run created is told by its own start, and listing its occurrences changes nothing', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const rule = 'FREQ=DAILY;COUNT=3';
    ledger.record(
      'create_event',
      { title: 'Standup', start_at: '2026-04-02T10:00:00Z', recurrence_rule: rule },
      exec({ data: row('2026-04-02T10:00:00.000Z') }),
    );
    ledger.record('get_events', {}, occurrences());
    ledger.record('update_event', failedUpdate(), eventNotFound);
    const lines = (ledger.finalNotice(view()) ?? '').split('\n');
    expect(lines).toContain('Created: event “Standup” (April 2, 10:00).');
    expect(lines.find((l) => l.startsWith('Not updated'))).toBe(
      'Not updated: event “Standup”, fields: title — nothing was changed.',
    );
  });

  test('a snooze and a list afterwards leave no pre-snooze time on a later write', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Standup', start_at: '2026-04-02T10:00:00Z' },
      exec({ data: row('2026-04-02T10:00:00.000Z') }),
    );
    ledger.record('snooze_event', { event_id: 9, minutes: 60 }, exec());
    ledger.record('get_events', {}, exec({ data: [row('2026-04-02T11:00:00.000Z')] }));
    ledger.record('update_event', failedUpdate(), eventNotFound);
    const lines = (ledger.finalNotice(view()) ?? '').split('\n');
    expect(lines.find((l) => l.startsWith('Not updated'))).toBe(
      'Not updated: event “Standup”, fields: title — nothing was changed.',
    );
    const snoozed = lines.find((l) => l.startsWith('Done: change'));
    expect(lines).toContain('Created: event “Standup” (April 2, 10:00).');
    expect(snoozed).toBeDefined();
    expect(snoozed).not.toMatch(/April|10:00|11:00/);
  });

  test.each([
    ['America/New_York', '2030-04-20'],
    ['America/New_York', '2030-04-20T04:00:00Z'],
    ['Europe/Belgrade', '2030-04-20'],
    ['Europe/Belgrade', '2030-04-19T22:00:00Z'],
    ['Pacific/Auckland', '2030-04-20'],
    ['Pacific/Auckland', '2030-04-19T12:00:00Z'],
  ])('%s: a successful update of an all-day start %s is told on the calendar day it wrote', (timezone, start) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const moved = exec({ data: { id: 9, title: 'Camp', date: '2030-04-19', all_day: true } });
    ledger.record('update_event', { event_id: 9, start_at: start }, moved, false, timezone);
    ledger.record('send_invitation', { event_id: 9, invitee_id: FRIEND }, eventNotFound);
    const text = ledger.finalNotice({ ...receiptViewFor('en'), timezone, now: new Date('2030-04-01T09:00:00Z') }) ?? '';
    expect(text).toContain('Updated: event “Camp” (April 20), fields: start time.');
  });

  test('an all-day flag of null is no flag: a successful update with no summary names the event by title alone', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('get_event', { event_id: 9 }, exec({ data: row('2026-04-02T10:00:00.000Z') }));
    ledger.record(
      'update_event',
      { event_id: 9, start_at: '2030-04-20', all_day: null },
      exec(),
      false,
      'America/New_York',
    );
    expect(ledger.summary({ ...receiptViewFor('en'), timezone: 'America/New_York' })).toContain(
      'Updated: event “Standup”, fields: start time, all day.',
    );
  });

  test('a successful update with no summary and no all-day flag names the event by title alone', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('get_event', { event_id: 9 }, exec({ data: row('2026-04-02T10:00:00.000Z') }));
    ledger.record('update_event', { event_id: 9, start_at: '2030-04-20' }, exec(), false, 'America/New_York');
    ledger.record('send_invitation', { event_id: 9, invitee_id: FRIEND }, eventNotFound);
    const text = ledger.finalNotice({ ...receiptViewFor('en'), timezone: 'America/New_York' }) ?? '';
    expect(text).toContain('Updated: event “Standup”, fields: start time.');
  });

  test.each([
    [
      'a timed update with the flag as a string',
      { event_id: 9, start_at: '2026-04-05T10:00:00Z', all_day: 'false' },
      'Updated: event “Standup” (April 5, 06:00), fields: start time, all day.',
    ],
    [
      'an all-day update with the flag as a string',
      { event_id: 9, start_at: '2030-04-20', all_day: 'true' },
      'Updated: event “Standup” (April 20), fields: start time, all day.',
    ],
  ])('%s with no summary is told by its own start', (_name, input, expected) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('get_event', { event_id: 9 }, exec({ data: row('2026-04-02T10:00:00.000Z') }));
    ledger.record('update_event', input, exec(), false, 'America/New_York');
    expect(
      ledger.summary({ ...receiptViewFor('en'), timezone: 'America/New_York', now: new Date('2026-03-01T09:00:00Z') }),
    ).toContain(expected);
  });

  test('a failed or unconfirmed update that asked for a start names the event by title alone', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('get_event', { event_id: 9 }, exec({ data: row('2026-04-02T10:00:00.000Z') }));
    ledger.record('update_event', { event_id: 9, start_at: '2026-04-05T10:00:00Z' }, eventNotFound);
    ledger.record('update_event', { event_id: 10, start_at: '2026-04-06T10:00:00Z' }, uncertain);
    ledger.record('get_event', { event_id: 10 }, exec({ data: { ...row('2026-04-02T10:00:00.000Z'), id: 10 } }));
    const text = ledger.finalNotice(view()) ?? '';
    expect(text).toContain('Not updated: event “Standup”, fields: start time — nothing was changed.');
    expect(text).toContain('Could not confirm the update: event “Standup”, fields: start time.');
    expect(text).not.toMatch(/April|10:00/);
  });
});

describe('an update rewrites what the earlier create now stands for', () => {
  const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z', end_at: '2026-10-31T10:30:00Z' };
  const plain = { title: 'Call', start_at: '2026-10-31T10:00:00Z' };

  test('after a details-only update a failed repeat asking for those details is still folded', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('update_event', { event_id: 601, description: 'Bring snacks' }, okCall);
    ledger.record('create_event', { ...call, description: 'Bring snacks' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('a repeat asking for the old details is a visible failure after such an update', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('update_event', { event_id: 601, description: 'Bring snacks' }, okCall);
    ledger.record('create_event', call, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  test('a failure the update corrected no longer shows', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
    ledger.record('update_event', { event_id: 601, location: 'Office' }, okCall);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('an unknown repeat with other details stays its own line and sets no duplicate warning', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, uncertain);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('Could not confirm creation: event “Call”');
    expect(text).not.toContain('A repeat of the creation');
  });

  type ClearableField = 'end_at' | 'location' | 'description';
  interface CreateInput {
    title: string;
    start_at: string;
    end_at?: string;
    location?: string;
    description?: string;
  }

  test.each<[ClearableField, CreateInput]>([
    ['end_at', call],
    ['location', { ...call, location: 'Office' }],
    ['description', { ...call, description: 'Agenda' }],
  ])('clearing %s makes the event match a create that never had it', (field, original) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', original, okCall);
    ledger.record('update_event', { event_id: 601, [field]: null }, okCall);
    const bare: CreateInput = { ...original };
    delete bare[field];
    ledger.record('create_event', bare, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('a refused update leaves the create and its refused repeat as they were', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    ledger.record('update_event', { event_id: 601, location: 'Office' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Call”');
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Call”');
  });

  test('a skipped repeat the update then matches is settled', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, { success: false, disposition: 'skipped' });
    ledger.record('update_event', { event_id: 601, location: 'Office' }, okCall);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('a renamed or moved event is keyed by its new identity: a repeat of the new one is folded, of the old one visible', () => {
    const moved = exec({ data: { id: 601, title: 'Sync', date: '2026-10-31', time: '11:00', all_day: false } });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', plain, okCall);
    ledger.record('update_event', { event_id: 601, title: 'Sync', start_at: '2026-10-31T11:00:00Z' }, moved);
    ledger.record('create_event', { title: 'sync', start_at: '2026-10-31T11:00:00Z' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
    ledger.record('create_event', plain, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Call”');
  });

  test('a refused create is settled by an update that renames the event into it', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', plain, okCall);
    ledger.record('create_event', { title: 'Sync', start_at: '2026-10-31T11:00:00Z' }, rejectedCreate);
    ledger.record(
      'update_event',
      { event_id: 601, title: 'Sync', start_at: '2026-10-31T11:00:00Z' },
      exec({ data: { id: 601, title: 'Sync', date: '2026-10-31', time: '11:00', all_day: false } }),
    );
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('a successful recurrence removal on an all-day series, with no restated start, retires the create', () => {
    const series = { title: 'Camp', all_day: true, start_at: '2030-04-15', recurrence_rule: 'FREQ=DAILY;COUNT=3' };
    const day = exec({ data: { id: 802, title: 'Camp', date: '2030-04-15', all_day: true } });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', series, day);
    ledger.record('update_event', { event_id: 802, recurrence_rule: null }, day);
    ledger.record('create_event', series, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  test('an all-day flip with the start restated is re-keyed: the repeat of the new event is folded', () => {
    const flipped = exec({ data: { id: 601, title: 'Call', date: '2026-10-31', all_day: true } });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', plain, okCall);
    ledger.record('update_event', { event_id: 601, all_day: true, start_at: '2026-10-31' }, flipped);
    ledger.record('create_event', { ...plain, start_at: '2026-10-31', all_day: true }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });
});

describe('a refused create is compared only with a success in the same calendar', () => {
  test('another owner or scope is not a field of the line', () => {
    const at = { title: 'Standup', start_at: '2026-10-31T09:00:00Z' };
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      at,
      exec({ data: { id: 701, title: 'Standup', date: '2026-10-31', time: '09:00', all_day: false } }),
    );
    ledger.record('create_event', { ...at, owner_id: OWNER, location: 'Office' }, rejectedCreate);
    const line = (ledger.finalNotice(receiptViewFor('en')) ?? '').split('\n').find((l) => l.startsWith('Not created'));
    expect(line).toBeDefined();
    expect(line).not.toContain('location');
  });
});

describe('a start without an offset is never read in the server zone', () => {
  test('refused with no offset, then created with one: the refused line names no day or time', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { title: 'Standup', start_at: '2026-10-31T10:00:00' }, rejectedCreate);
    ledger.record(
      'create_event',
      { title: 'Standup', start_at: '2026-10-31T10:00:00+03:00' },
      exec({ data: { id: 701, title: 'Standup', date: '2026-10-31', time: '10:00', all_day: false } }),
    );
    const view = { ...receiptViewFor('en'), timezone: 'Europe/Moscow', now: new Date('2026-10-31T05:00:00Z') };
    const lines = (ledger.finalNotice(view) ?? '').split('\n');
    expect(lines).toContain('Not created: event “Standup” — nothing was changed.');
    expect(lines).toContain('Created: event “Standup” (today, 10:00).');
  });
});

describe('a refused create that differs only by recurrence or all-day names that field', () => {
  const at = { title: 'Standup', start_at: '2026-10-31T09:00:00Z' };
  const standup = exec({ data: { id: 701, title: 'Standup', date: '2026-10-31', time: '09:00', all_day: false } });
  const lines = (ledger: WriteOutcomes, lang: 'ru' | 'en') =>
    (ledger.finalNotice({ ...receiptViewFor(lang), now: new Date('2026-10-31T08:00:00Z') }) ?? '').split('\n');

  test.each([
    [
      'en',
      { recurrence_rule: 'FREQ=WEEKLY' },
      'Not created: event “Standup” (today, 09:00), fields: recurrence — nothing was changed.',
    ],
    [
      'ru',
      { recurrence_rule: 'FREQ=WEEKLY' },
      'Не создано: событие «Standup» (сегодня, 09:00), поля: повторение — ничего не изменилось.',
    ],
    ['en', { all_day: true }, 'Not created: event “Standup” (today), fields: all day — nothing was changed.'],
  ] as const)('%s: refused with %j, then created plain', (lang, extra, expected) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...at, ...extra }, rejectedCreate);
    ledger.record('create_event', at, standup);
    expect(lines(ledger, lang)).toContain(expected);
    expect(lines(ledger, lang).filter((l) => /^(Created|Создано)/.test(l))).toHaveLength(1);
  });
});

describe('a failed create kept visible next to a success names what it asked for differently', () => {
  test.each([
    ['en', { end_at: '2026-10-31T11:00:00Z' }, 'end time'],
    ['en', { location: 'Office' }, 'location'],
    ['en', { description: 'Agenda' }, 'description'],
    ['ru', { location: 'Office' }, 'место'],
  ] as const)('%s: %j', (lang, other, label) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z', end_at: '2026-10-31T10:30:00Z' };
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, ...other }, rejectedCreate);
    const line =
      ledger
        .finalNotice(receiptViewFor(lang))
        ?.split('\n')
        .find((l) => /Not created|Не создано/.test(l)) ?? '';
    expect(line).toContain(label);
  });
});

describe('failed creates next to one success stay separate lines', () => {
  const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z' };

  test('two unconfirmed repeats that differ in different details are two lines', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, uncertain);
    ledger.record('create_event', { ...call, description: 'Agenda' }, uncertain);
    const lines = (ledger.finalNotice(receiptViewFor('en')) ?? '').split('\n');
    expect(lines.filter((l) => l.startsWith('Could not confirm creation'))).toEqual([
      'Could not confirm creation: event “Call” (today, 10:00), fields: location.',
      'Could not confirm creation: event “Call” (today, 10:00), fields: description.',
    ]);
  });

  test('where targets are hidden, creates of different events do not merge', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const other = { title: 'Retro', start_at: '2026-10-31T15:00:00Z' };
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Room 1' }, uncertain);
    ledger.record(
      'create_event',
      other,
      exec({ data: { id: 602, title: 'Retro', date: '2026-10-31', time: '15:00', all_day: false } }),
    );
    ledger.record('create_event', { ...other, description: 'Notes' }, uncertain);
    const lines = (ledger.finalNotice({ ...receiptViewFor('en'), hideTargets: true }) ?? '').split('\n');
    expect(lines.filter((l) => l.startsWith('Could not confirm creation'))).toHaveLength(2);
  });

  test('the fields follow the event as an update re-keys it', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office', description: 'Agenda' }, rejectedCreate);
    ledger.record('update_event', { event_id: 601, location: 'Office' }, okCall);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain(
      'Not created: event “Call” (today, 10:00), fields: description',
    );
    const line =
      ledger
        .finalNotice(receiptViewFor('en'))
        ?.split('\n')
        .find((l) => l.startsWith('Not created')) ?? '';
    expect(line).not.toContain('location');
  });

  test('a second success that adds a detail is told as a plain creation', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, okCall);
    ledger.record('send_invitation', { event_id: 601, invitee_id: FRIEND }, eventNotFound);
    expect(ledger.finalNotice(receiptViewFor('en'))).not.toContain('fields:');
  });

  test('a folded unknown repeat makes the closing line ask to check the calendar', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', call, uncertain);
    ledger.record('send_invitation', { event_id: 601, invitee_id: FRIEND }, eventNotFound);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('Check the calendar before repeating anything');
    expect(text).not.toContain('Tell me what to repeat');
  });
});

describe('an unconfirmed update and the duplicate warnings', () => {
  const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z' };

  test('an unconfirmed update does not settle a refused create it would match', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    ledger.record('update_event', { event_id: 601, location: 'Office' }, uncertain);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Call”');
  });

  test('an unconfirmed update that changes nothing the create asked for keeps the create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('update_event', { event_id: 601, category: 'work' }, uncertain);
    ledger.record('create_event', call, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).not.toContain('Not created');
  });

  test('a retry that worked after an unknown invitation, plus a refusal, asks to check the calendar', () => {
    const delivered: Recorded = exec({ effect: { kind: 'invitation', delivery: 'delivered' } });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 601, invitee_id: FRIEND }, uncertain);
    ledger.record('send_invitation', { event_id: 601, invitee_id: FRIEND }, delivered);
    ledger.record('update_event', { event_id: 601, title: 'Sync' }, eventNotFound);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('Check the calendar before repeating anything');
    expect(text).not.toContain('Tell me what to repeat');
  });

  test('the repeat warning names the calendar the event lives in', () => {
    const req = { title: 'Board games', start_at: '2026-10-31T17:00:00Z', owner_id: OWNER };
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', req, created);
    ledger.record('create_event', req, uncertain);
    const view = { ...receiptView(secretaryContext('en')), now: new Date('2026-10-31T08:00:00Z') };
    expect(ledger.finalNotice(view)?.split('\n')).toContain(
      'A repeat of the creation could not be confirmed: event “Board games” (today, 17:00), calendar: Olga. Check the calendar for a duplicate.',
    );
  });

  test('a failed create is compared with the closest success of the event', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...call, location: 'Office' }, okCall);
    ledger.record('create_event', { ...call, location: 'Home' }, okCall);
    ledger.record('create_event', { ...call, location: 'Home', description: 'Agenda' }, rejectedCreate);
    const line =
      ledger
        .finalNotice(receiptViewFor('en'))
        ?.split('\n')
        .find((l) => l.startsWith('Not created')) ?? '';
    expect(line).toContain('fields: description');
    expect(line).not.toContain('location');
  });
});

describe('identical refused creates next to a success are one line', () => {
  const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z' };

  test('the same refused call sent twice is told once', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    const lines = ledger.finalNotice(receiptViewFor('en'))?.split('\n') ?? [];
    expect(lines.filter((l) => l.startsWith('Not created'))).toHaveLength(1);
  });

  test('a refused and an unconfirmed create with the same details stay separate lines', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    ledger.record('create_event', { ...call, location: 'Office' }, uncertain);
    const lines = ledger.finalNotice(receiptViewFor('en'))?.split('\n') ?? [];
    expect(lines.filter((l) => /^(Not created|Could not confirm creation)/.test(l))).toHaveLength(2);
  });

  test('refused creates that differ in their details stay separate lines', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    ledger.record('create_event', { ...call, location: 'Home' }, rejectedCreate);
    const lines = ledger.finalNotice(receiptViewFor('en'))?.split('\n') ?? [];
    expect(lines.filter((l) => l.startsWith('Not created'))).toHaveLength(2);
  });

  test('a refusal for another calendar or scope survives an update that matches it otherwise', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office', owner_id: OWNER }, rejectedCreate);
    ledger.record('create_event', { ...call, location: 'Office', scope: 'group' }, rejectedCreate);
    ledger.record('update_event', { event_id: 601, location: 'Office' }, okCall);
    const lines = ledger.finalNotice(receiptViewFor('en'))?.split('\n') ?? [];
    expect(lines.filter((l) => l.startsWith('Not created'))).toHaveLength(2);
  });
});

describe('a start-only update leaves the end as stored (update_event never shifts it)', () => {
  test('a refused repeat of the new start with the old end is folded, one with another end stays visible', () => {
    const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z', end_at: '2026-10-31T12:00:00Z' };
    const moved = exec({ data: { id: 601, title: 'Call', date: '2026-10-31', time: '11:00', all_day: false } });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('update_event', { event_id: 601, start_at: '2026-10-31T11:00:00Z' }, moved);
    ledger.record('create_event', { ...call, start_at: '2026-10-31T11:00:00Z' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
    ledger.record(
      'create_event',
      { ...call, start_at: '2026-10-31T11:00:00Z', end_at: '2026-10-31T11:30:00Z' },
      rejectedCreate,
    );
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('fields: end time');
  });
});

describe('an end that cannot be re-read in the other form', () => {
  test('a flip to all-day without a restated end retires the create: the original request stays visible', () => {
    const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z', end_at: '2026-10-31T10:30:00Z' };
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record(
      'update_event',
      { event_id: 601, all_day: true, start_at: '2026-10-31' },
      exec({ data: { id: 601, title: 'Call', date: '2026-10-31', all_day: true } }),
    );
    ledger.record('create_event', call, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Call”');
  });
});

describe('what an update leaves unsettled', () => {
  const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z' };

  test('an unknown failure that the update then matches still has to be checked', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, uncertain);
    ledger.record('update_event', { event_id: 601, location: 'Office' }, okCall);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Could not confirm creation');
  });

  test('an all-day flag changed without a start cannot be re-keyed: a failed repeat stays visible', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record(
      'update_event',
      { event_id: 601, all_day: true },
      exec({ data: { id: 601, title: 'Call', date: '2026-10-31', all_day: true } }),
    );
    ledger.record('create_event', call, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  test('an end restated in another all-day spelling keeps the end key', () => {
    const tz = 'Europe/Belgrade';
    const day = exec({ data: { id: 801, title: 'Camp', date: '2030-04-15', all_day: true } });
    const camp = { title: 'Camp', all_day: true, start_at: '2030-04-15', end_at: '2030-04-17' };
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', camp, day, false, tz);
    ledger.record('update_event', { event_id: 801, end_at: '2030-04-16T22:00:00Z' }, day, false, tz);
    ledger.record('create_event', camp, rejectedCreate, false, tz);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });
});

describe('two unknown repeats of one create keep both warnings', () => {
  test('even when an update moved the event between them', () => {
    const at = (time: string) => ({ title: 'Board games', start_at: `2026-10-31T${time}:00Z` });
    const row = (time: string): Recorded =>
      exec({ data: { id: 501, title: 'Board games', date: '2026-10-31', time, all_day: false } });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', at('17:00'), row('17:00'));
    ledger.record('create_event', at('17:00'), uncertain);
    ledger.record('update_event', { event_id: 501, start_at: '2026-10-31T19:00:00Z' }, row('19:00'));
    ledger.record('create_event', at('19:00'), uncertain);
    const view = { ...receiptViewFor('en'), now: new Date('2026-10-31T08:00:00Z') };
    const warnings = (ledger.finalNotice(view) ?? '')
      .split('\n')
      .filter((l) => l.startsWith('A repeat of the creation'));
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain('(today, 17:00)');
    expect(warnings.join('\n')).toContain('(today, 19:00)');
  });
});

describe('a repeat warning where targets are hidden', () => {
  test('two such repeats make one sentence', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    for (const [id, title] of [
      [1, 'A'],
      [2, 'B'],
    ] as const) {
      const input = { title, start_at: `2026-10-31T1${id}:00:00Z` };
      ledger.record(
        'create_event',
        input,
        exec({ data: { id, title, date: '2026-10-31', time: `1${id}:00`, all_day: false } }),
      );
      ledger.record('create_event', input, uncertain);
    }
    const lines = ledger.finalNotice({ ...receiptViewFor('en'), hideTargets: true })?.split('\n') ?? [];
    expect(lines.filter((l) => l.startsWith('A repeat of an event creation'))).toHaveLength(1);
  });

  test('is a sentence without an event', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T17:00:00Z' }, created);
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T17:00:00Z' }, uncertain);
    const view = { ...receiptViewFor('en'), hideTargets: true };
    expect(ledger.finalNotice(view)?.split('\n')).toContain(
      'A repeat of an event creation could not be confirmed. Check the calendar for a duplicate.',
    );
  });
});

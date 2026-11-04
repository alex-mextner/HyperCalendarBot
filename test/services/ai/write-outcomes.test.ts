/** Structured evidence tests: prose and skipped calls cannot prove write success. */
import { describe, expect, test } from 'bun:test';
import { WRITE_TOOLS } from '../../../src/services/ai/tool-executor.ts';
import { WriteOutcomes } from '../../../src/services/ai/write-outcomes.ts';
import type { ReceiptView } from '../../../src/services/ai/write-receipt.ts';

/** A requester (1001) who has no contacts and manages no calendar: nothing is named by id. */
function view(language: string, overrides: Partial<ReceiptView> = {}): ReceiptView {
  return {
    language,
    timezone: 'UTC',
    hideTargets: false,
    requesterId: 1001,
    now: new Date('2026-10-31T09:00:00Z'),
    personLabel: () => null,
    personKey: ({ id, username }) => (id === null ? `@${username}` : `id:${id}`),
    calendarOwnerName: () => null,
    hasCalendarAccess: () => false,
    ...overrides,
  };
}
const en = view('en');
const rejected = { success: false, disposition: 'failed', mutationState: 'not_applied' } as const;
const unconfirmed = { success: false, disposition: 'failed' } as const;

test('correction clears only the same operation and target', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('delete_event', { event_id: '1', owner_id: 123 }, { success: false, disposition: 'failed' });
  ledger.record('update_event', { event_id: 1 }, { success: true, disposition: 'executed' });
  ledger.record('delete_event', { event_id: 2 }, { success: true, disposition: 'executed' });
  expect(ledger.finalNotice(en)).toContain('Could not confirm the deletion: event');
  ledger.record('delete_event', { event_id: 1, owner_id: 123 }, { success: true, disposition: 'executed' });
  expect(ledger.finalNotice(en)).toBeNull();
});

test('invitations distinguish recipients and never use output prose', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  const failure = { success: false, disposition: 'failed', output: 'Successfully sent everything' } satisfies {
    success: boolean;
    disposition: 'failed';
    output: string;
  };
  ledger.record('send_invitation', { event_id: 1, invitee_id: '2' }, failure);
  ledger.record('send_invitation', { event_id: '1', invitee_id: 3 }, { success: true, disposition: 'executed' });
  const notice = ledger.finalNotice(en) ?? '';
  expect(notice).toContain('Could not confirm that the invitation to the event went through: 1 person.');
  expect(notice).not.toContain('Successfully');
  ledger.record('send_invitation', { event_id: '1', invitee_id: 2 }, { success: true, disposition: 'executed' });
  expect(ledger.finalNotice(en)).toContain('duplicate');
});

test('a corrected invitation retry that adds owner_id supersedes the rejected call (event ids are global)', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('send_invitation', { event_id: 5, invitee_id: 77 }, rejected);
  expect(ledger.finalNotice(en)).toContain('was not sent: 1 person');
  ledger.record(
    'send_invitation',
    { event_id: 5, invitee_id: '77', owner_id: 2002 },
    {
      success: true,
      disposition: 'executed',
      mutationState: 'confirmed',
      effect: { kind: 'invitation', delivery: 'delivered' },
    },
  );
  expect(ledger.finalNotice(en)).toBeNull();
});

test('a delivered invitation does not replace a normal successful final response with execution jargon', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record(
    'send_invitation',
    { event_id: 1, invitee_id: 2 },
    {
      success: true,
      disposition: 'executed',
      mutationState: 'confirmed',
      effect: { kind: 'invitation', delivery: 'delivered' },
    },
  );
  expect(ledger.finalNotice(en)).toBeNull();
});

test('an interrupted successful run reports facts without any attempt framing', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record(
    'create_event',
    { title: 'Walk' },
    { success: true, disposition: 'executed', mutationState: 'confirmed' },
  );
  ledger.record(
    'send_invitation',
    { event_id: 1, invitee_id: 2 },
    {
      success: true,
      disposition: 'executed',
      mutationState: 'confirmed',
      effect: { kind: 'invitation', delivery: 'delivered' },
    },
  );
  expect(ledger.finalNotice(view('ru'), true)?.split('\n')).toEqual([
    'Создано: событие «Walk».',
    'Приглашение на событие отправлено: 1 человек.',
    'Запрос прерван. Часть действий могла уже выполниться; автоматического повтора не будет.',
  ]);
});

test('read and conversation controls do not become failed writes', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  for (const operation of ['get_event', 'ask_user', 'supplement_skip', 'end_conversation']) {
    ledger.record(operation, {}, { success: false, disposition: 'failed' });
  }
  expect(ledger.finalNotice(en)).toBeNull();
});

test('recipient ID is authoritative when a corrected invitation also supplies a username', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('send_invitation', { event_id: 1, invitee_id: '2' }, rejected);
  ledger.record(
    'send_invitation',
    { event_id: '1', invitee_id: 2, invitee_username: 'synthetic' },
    { success: true, disposition: 'executed' },
  );
  expect(ledger.finalNotice(en)).toBeNull();
});

test('unrelated update fields cannot erase failed intent', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('update_event', { event_id: 42, title: 123, start_at: 'bad' }, rejected);
  ledger.record('update_event', { event_id: 42, location: 'Office' }, { success: true, disposition: 'executed' });
  expect(ledger.finalNotice(en)).toContain('Not updated: event, fields: title, start time');
  ledger.record('update_event', { event_id: 42, title: 'Fixed' }, { success: true, disposition: 'executed' });
  expect(ledger.finalNotice(en)).toContain('Not updated: event, fields: start time');
  ledger.record(
    'update_event',
    { event_id: 42, start_at: '2030-01-01T10:00:00Z' },
    { success: true, disposition: 'executed' },
  );
  expect(ledger.finalNotice(en)).toBeNull();
});

test('a place the model claims is never reported as written (#620)', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  const claimed = { location_verified: 1, resolved_address: 'Far Away 1', venue_name: 'Far Away Venue' };
  ledger.record('update_event', { event_id: 42, location: 'Office', ...claimed }, rejected);
  ledger.record('update_event', { event_id: 42, location: 'Office' }, { success: true, disposition: 'executed' });
  expect(ledger.finalNotice(en)).toBeNull();
  ledger.record(
    'update_event',
    { event_id: 43, title: 'Lunch', ...claimed },
    { success: true, disposition: 'executed' },
  );
  expect(ledger.summary(en)?.split('\n')).toEqual([
    'Updated: event, fields: location.',
    'Updated: event, fields: title.',
  ]);
});

test('safe localized targets never derive authoritative reasons from free-form errors', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('delete_event', { event_id: 42 }, { success: false, disposition: 'failed', error: 'Not owner' });
  ledger.record(
    'delete_event',
    { event_id: 43 },
    { success: false, disposition: 'failed', error: 'Not found\n at secret(provider)' },
  );
  const notice = ledger.finalNotice(en) ?? '';
  expect(notice).toContain('Could not confirm the deletion: event.');
  expect(notice).not.toMatch(/#\d|42|43/);
  expect(notice).not.toContain('permission denied');
  expect(notice).not.toContain('secret');
  expect(ledger.finalNotice(view('ru'))).toContain('Не удалось подтвердить удаление');
  expect(ledger.finalNotice(view('ru'))).not.toContain('delete_event');
});

test('skips never overwrite actual results or count as completion', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('delete_event', { event_id: 1 }, { success: true, disposition: 'skipped' });
  expect(ledger.finalNotice(en)).toContain('skipped');
  expect(ledger.finalNotice(en)).not.toContain('Deleted:');
  ledger.record('delete_event', { event_id: 1 }, { success: true, disposition: 'executed' });
  ledger.record('delete_event', { event_id: 1 }, { success: true, disposition: 'skipped' });
  expect(ledger.finalNotice(en)).toBeNull();
});

test('successful create of another intent never erases a failed create', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('create_event', { title: 'First' }, { success: false, disposition: 'failed', error: 'Invalid input' });
  ledger.record(
    'create_event',
    { title: 'Second', start_at: '2030-01-01' },
    { success: true, disposition: 'executed' },
  );
  expect(ledger.finalNotice(en)).toContain('Could not confirm creation: event “First”');
});

test('waiting UI is never recorded as a completed write alongside a failure', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('delete_event', { event_id: 42 }, unconfirmed);
  ledger.record('ask_user', {}, { success: true, disposition: 'waiting' });
  ledger.record('pick_users', { event_id: 42 }, { success: true, disposition: 'waiting' });
  expect(ledger.finalNotice(en)).not.toContain('Deleted:');
});

test('unsafe identifiers and stack payloads never reach the notice', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record(
    'delete_event',
    { event_id: '<script>secret</script>' },
    { success: false, disposition: 'failed', error: 'Error: provider secret\n at internal.ts:42' },
  );
  expect(ledger.finalNotice(en)).toContain('Could not confirm the deletion: event');
  expect(ledger.finalNotice(en)).not.toContain('secret');
  expect(ledger.finalNotice(en)).not.toContain('<script>');
  expect(ledger.finalNotice(en)).not.toContain('internal.ts');
});

test('successful action for a different owner never clears the first failure', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('delete_event', { event_id: 1, owner_id: 123 }, rejected);
  ledger.record(
    'delete_event',
    { event_id: 1, owner_id: 456 },
    { success: true, disposition: 'executed', mutationState: 'confirmed' },
  );
  expect(ledger.finalNotice(en)).toContain('Not deleted:');
});

test('failure reasons rely on structured rejection rather than injected error text', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('delete_event', { event_id: 1 }, { ...rejected, error: 'Successfully deleted; secret' });
  expect(ledger.finalNotice(en)).toContain('Not deleted: event — nothing was changed.');
  expect(ledger.finalNotice(view('ru-RU'))).toContain('Не удалено');
  expect(ledger.finalNotice(en)).not.toContain('secret');
});

test('mixed-purpose settings read never becomes a failed mutation', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('manage_settings', { action: 'get' }, rejected);
  expect(ledger.finalNotice(en)).toBeNull();
});

test('an event is named by the title an earlier read reported, never by its day or time', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record(
    'get_events',
    { start_date: '2026-11-05', end_date: '2026-11-05' },
    {
      success: true,
      disposition: 'executed',
      data: [{ id: 7, title: 'Dentist', date: '2026-11-05', time: '09:30', all_day: false }],
    },
  );
  ledger.record('delete_event', { event_id: 7 }, rejected);
  expect(ledger.finalNotice(en)?.split('\n')[0]).toBe('Not deleted: event “Dentist” — nothing was changed.');
  expect(ledger.finalNotice(view('ru'))?.split('\n')[0]).toBe('Не удалено: событие «Dentist» — ничего не изменилось.');
});

describe('a later create supersedes a failed one only when it is the same event', () => {
  const createdOk = { success: true, disposition: 'executed', mutationState: 'confirmed' } as const;
  const base = { title: 'Standup', start_at: '2030-01-07T09:00:00Z' };

  test('a failed group create is not folded away behind a personal success', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...base, scope: 'group' }, rejected);
    ledger.record('create_event', { ...base, scope: 'personal' }, createdOk);
    expect(ledger.finalNotice(en)).toContain('Not created: event “Standup”');
  });

  test('an omitted scope is the chat default: a group chat does not mistake it for personal', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', base, rejected, true);
    ledger.record('create_event', { ...base, scope: 'personal' }, createdOk, true);
    expect(ledger.finalNotice(en)).toContain('Not created: event “Standup”');
  });

  test('a retry that names the default scope still supersedes the failure', () => {
    const personal = new WriteOutcomes(WRITE_TOOLS);
    personal.record('create_event', base, rejected);
    personal.record('create_event', { ...base, scope: 'personal' }, createdOk);
    expect(personal.finalNotice(en)).toBeNull();
    const group = new WriteOutcomes(WRITE_TOOLS);
    group.record('create_event', base, rejected, true);
    group.record('create_event', { ...base, scope: 'group' }, createdOk, true);
    expect(group.finalNotice(en)).toBeNull();
  });

  test('a failed recurring create is not folded away behind a one-off success', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...base, recurrence_rule: 'FREQ=WEEKLY' }, rejected);
    ledger.record('create_event', base, createdOk);
    expect(ledger.finalNotice(en)).toContain('Not created: event “Standup”');
  });

  test('a failed one-off create is not folded away behind a recurring success', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', base, rejected);
    ledger.record('create_event', { ...base, recurrence_rule: 'FREQ=WEEKLY' }, createdOk);
    expect(ledger.finalNotice(en)).toContain('Not created: event “Standup”');
  });

  test('a different recurrence is a different event', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...base, recurrence_rule: 'FREQ=WEEKLY' }, rejected);
    ledger.record('create_event', { ...base, recurrence_rule: 'FREQ=DAILY' }, createdOk);
    expect(ledger.finalNotice(en)).toContain('Not created: event “Standup”');
  });

  test('the same recurrence, however spelled, still supersedes the failure', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...base, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO' }, rejected);
    ledger.record('create_event', { ...base, recurrence_rule: ' freq=weekly; byday=mo ' }, createdOk);
    expect(ledger.finalNotice(en)).toBeNull();
  });

  // The same RRULE in another order of its parts is the same series (RFC 5545 §3.3.10), and an
  // omitted INTERVAL means 1: the receipt must not report both "Not created" and "Created".
  test.each([
    ['reordered parts', 'FREQ=WEEKLY;BYDAY=MO', 'BYDAY=MO;FREQ=WEEKLY'],
    ['reordered parts and case', 'FREQ=WEEKLY;BYDAY=MO', 'byday=mo; freq=weekly'],
    ['the RRULE: prefix', 'FREQ=WEEKLY;BYDAY=MO', 'RRULE:FREQ=WEEKLY;BYDAY=MO'],
    ['an explicit default interval', 'FREQ=WEEKLY;BYDAY=MO', 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO'],
    ['the order of a list value', 'FREQ=WEEKLY;BYDAY=MO,WE', 'BYDAY=WE,MO;FREQ=WEEKLY'],
    ['an until bound in another position', 'FREQ=DAILY;UNTIL=20301231T235959Z', 'UNTIL=20301231T235959Z;FREQ=DAILY'],
  ])('the same recurrence with %s still supersedes the failure', (_case, first, retry) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...base, recurrence_rule: first }, rejected);
    ledger.record('create_event', { ...base, recurrence_rule: retry }, createdOk);
    expect(ledger.finalNotice(en)).toBeNull();
  });

  test.each([
    ['another weekday', 'FREQ=WEEKLY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=TU'],
    ['another interval', 'FREQ=WEEKLY;BYDAY=MO', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'],
    ['a count where the other has none', 'FREQ=WEEKLY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=MO;COUNT=3'],
    ['another weekday set', 'FREQ=WEEKLY;BYDAY=MO,WE', 'FREQ=WEEKLY;BYDAY=MO,FR'],
    ['a nth weekday against every weekday', 'FREQ=MONTHLY;BYDAY=1MO', 'FREQ=MONTHLY;BYDAY=MO'],
  ])('a genuinely different recurrence (%s) stays a different event', (_case, first, retry) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...base, recurrence_rule: first }, rejected);
    ledger.record('create_event', { ...base, recurrence_rule: retry }, createdOk);
    expect(ledger.finalNotice(en)).toContain('Not created: event “Standup”');
  });
});

/** Structured evidence tests: prose and skipped calls cannot prove write success. */
import { expect, test } from 'bun:test';
import { WRITE_TOOLS } from '../../../src/services/ai/tool-executor.ts';
import { WriteOutcomes } from '../../../src/services/ai/write-outcomes.ts';

test('correction clears only the same operation and target', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('delete_event', { event_id: '1', owner_id: 123 }, { success: false, disposition: 'failed' });
  ledger.record('update_event', { event_id: 1 }, { success: true, disposition: 'executed' });
  ledger.record('delete_event', { event_id: 2 }, { success: true, disposition: 'executed' });
  expect(ledger.finalNotice('en')).toContain('Not completed: Delete event');
  ledger.record('delete_event', { event_id: 1, owner_id: 123 }, { success: true, disposition: 'executed' });
  expect(ledger.finalNotice('en')).toBeNull();
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
  expect(ledger.finalNotice('en')).toContain('Not completed: Send invitation');
  ledger.record('send_invitation', { event_id: '1', invitee_id: 2 }, { success: true, disposition: 'executed' });
  expect(ledger.finalNotice('en')).toBeNull();
});

test('read and conversation controls do not become failed writes', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  for (const operation of ['get_event', 'ask_user', 'supplement_skip', 'end_conversation']) {
    ledger.record(operation, {}, { success: false, disposition: 'failed' });
  }
  expect(ledger.finalNotice('en')).toBeNull();
});

test('recipient ID is authoritative when a corrected invitation also supplies a username', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('send_invitation', { event_id: 1, invitee_id: '2' }, { success: false, disposition: 'failed' });
  ledger.record(
    'send_invitation',
    { event_id: '1', invitee_id: 2, invitee_username: 'synthetic' },
    { success: true, disposition: 'executed' },
  );
  expect(ledger.finalNotice('en')).toBeNull();
});

test('unrelated update fields cannot erase failed intent', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record(
    'update_event',
    { event_id: 42, title: 123, start_at: 'bad' },
    { success: false, disposition: 'failed' },
  );
  ledger.record('update_event', { event_id: 42, location: 'Office' }, { success: true, disposition: 'executed' });
  expect(ledger.finalNotice('en')).toContain('title');
  expect(ledger.finalNotice('en')).toContain('start');
  ledger.record('update_event', { event_id: 42, title: 'Fixed' }, { success: true, disposition: 'executed' });
  expect(ledger.finalNotice('en')).toContain('Not completed:');
  ledger.record(
    'update_event',
    { event_id: 42, start_at: '2030-01-01T10:00:00Z' },
    { success: true, disposition: 'executed' },
  );
  expect(ledger.finalNotice('en')).toBeNull();
});

test('safe localized targets never derive authoritative reasons from free-form errors', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('delete_event', { event_id: 42 }, { success: false, disposition: 'failed', error: 'Not owner' });
  ledger.record(
    'delete_event',
    { event_id: 43 },
    { success: false, disposition: 'failed', error: 'Not found\n at secret(provider)' },
  );
  expect(ledger.finalNotice('en')).toContain('#42');
  expect(ledger.finalNotice('en')).toContain('#43');
  expect(ledger.finalNotice('en')).toContain('completion not confirmed');
  expect(ledger.finalNotice('en')).not.toContain('permission denied');
  expect(ledger.finalNotice('en')).not.toContain('secret');
  expect(ledger.finalNotice('ru')).toContain('Удаление');
  expect(ledger.finalNotice('ru')).not.toContain('delete_event');
});

test('skips never overwrite actual results or count as completion', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('delete_event', { event_id: 1 }, { success: true, disposition: 'skipped' });
  expect(ledger.finalNotice('en')).toContain('skipped');
  expect(ledger.finalNotice('en')).not.toContain('Completed:');
  ledger.record('delete_event', { event_id: 1 }, { success: true, disposition: 'executed' });
  ledger.record('delete_event', { event_id: 1 }, { success: true, disposition: 'skipped' });
  expect(ledger.finalNotice('en')).toBeNull();
});

test('successful create of another intent never erases a failed create', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('create_event', { title: 'First' }, { success: false, disposition: 'failed', error: 'Invalid input' });
  ledger.record(
    'create_event',
    { title: 'Second', start_at: '2030-01-01' },
    { success: true, disposition: 'executed' },
  );
  expect(ledger.finalNotice('en')).toContain('Not completed: Create event');
});

test('waiting UI is never recorded as a completed write alongside a failure', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('delete_event', { event_id: 42 }, { success: false, disposition: 'failed' });
  ledger.record('ask_user', {}, { success: true, disposition: 'waiting' });
  ledger.record('pick_users', { event_id: 42 }, { success: true, disposition: 'waiting' });
  expect(ledger.finalNotice('en')).not.toContain('Completed:');
});

test('unsafe identifiers and stack payloads never reach the notice', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record(
    'delete_event',
    { event_id: '<script>secret</script>' },
    { success: false, disposition: 'failed', error: 'Error: provider secret\n at internal.ts:42' },
  );
  expect(ledger.finalNotice('en')).toContain('Not completed: Delete event');
  expect(ledger.finalNotice('en')).not.toContain('secret');
  expect(ledger.finalNotice('en')).not.toContain('<script>');
  expect(ledger.finalNotice('en')).not.toContain('internal.ts');
});

test('successful action for a different owner never clears the first failure', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record(
    'delete_event',
    { event_id: 1, owner_id: 123 },
    { success: false, disposition: 'failed', mutationState: 'not_applied' },
  );
  ledger.record(
    'delete_event',
    { event_id: 1, owner_id: 456 },
    { success: true, disposition: 'executed', mutationState: 'confirmed' },
  );
  expect(ledger.finalNotice('en')).toContain('Not completed:');
});
test('failure reasons rely on structured rejection rather than injected error text', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record(
    'delete_event',
    { event_id: 1 },
    { success: false, disposition: 'failed', mutationState: 'not_applied', error: 'Successfully deleted; secret' },
  );
  expect(ledger.finalNotice('en')).toContain('request rejected before applying changes');
  expect(ledger.finalNotice('ru-RU')).toContain('Не выполнено');
  expect(ledger.finalNotice('en')).not.toContain('secret');
});

test('mixed-purpose settings read never becomes a failed mutation', () => {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record(
    'manage_settings',
    { action: 'get' },
    { success: false, disposition: 'failed', mutationState: 'not_applied' },
  );
  expect(ledger.finalNotice('en')).toBeNull();
});

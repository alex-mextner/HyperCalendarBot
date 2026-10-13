// Import routing verifies scene payloads and group timezone prerequisites offline.
import { expect, mock, test } from 'bun:test';
import { Scene } from '@gramio/scenes';
import { handleImport } from '../../../src/bot/commands/import.ts';

const scene = new Scene('import-fixture');
function fixture(type: string, language = 'en') {
  const send = mock(async (_text: string) => {});
  const enter = mock(async () => {});
  const ctx = { chat: { type, id: -10042 }, dbUser: { language }, send, scene: { enter } };
  return { ctx, send, enter };
}

test('private import enters scene without group context', async () => {
  const f = fixture('private');
  await handleImport(f.ctx, scene);
  expect(f.enter).toHaveBeenCalledWith(scene);
  expect(f.send).not.toHaveBeenCalled();
});

test('groups require a timezone and show localized setup instructions', async () => {
  for (const [language, message] of [
    ['en', 'Set the group timezone first'],
    ['ru', 'Сначала задайте таймзону группы'],
    ['de', 'Set the group timezone first'],
  ]) {
    const f = fixture('group', language);
    await handleImport(f.ctx, scene);
    expect(f.enter).not.toHaveBeenCalled();
    expect(f.send.mock.calls[0]![0]).toContain(message!);
  }
});

test('supergroup import looks up timezone and passes exact scene state', async () => {
  const f = fixture('supergroup');
  const getTimezone = mock(() => 'Europe/Belgrade');
  await handleImport(f.ctx, scene, { getTimezone });
  expect(getTimezone).toHaveBeenCalledWith(-10042);
  expect(f.enter).toHaveBeenCalledWith(scene, { groupId: -10042, groupTimezone: 'Europe/Belgrade' });
  expect(f.send).not.toHaveBeenCalled();
});

test('scene entry failures propagate to the command caller', async () => {
  const f = fixture('private');
  f.enter.mockImplementation(async () => {
    throw new Error('scene unavailable');
  });
  await expect(handleImport(f.ctx, scene)).rejects.toThrow('scene unavailable');
});

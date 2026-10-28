// Pins the admin intent-edit flow: model answers are retried until they parse, an edit is validated
// against the workflow/pattern combination that would be stored, and only valid edits reach the repo.

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, type Mock, mock, spyOn, test } from 'bun:test';
import type { AnyBot, MessageContext } from 'gramio';
import { handleIntentEditInstruction } from '../../../src/bot/handlers/message/intent-edit.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { IntentRepository } from '../../../src/database/repositories/intent.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import * as streaming from '../../../src/services/ai/streaming.ts';
import { stub } from '../partial-stub.ts';
import { sentMessage } from '../telegram-fixtures.ts';

interface FakeCtx {
  send: Mock<() => Promise<MessageContext<AnyBot>>>;
}

function answer(text: string): StreamRoundResult {
  return { text } as StreamRoundResult;
}

describe('handleIntentEditInstruction', () => {
  let intentRepo: IntentRepository;
  let intentId: number;
  const session = () => ({ intentId, state: 'awaiting_instructions' as const, createdAt: Date.now() });
  let stream: Mock<typeof streaming.aiStreamRound>;

  function makeCtx(): FakeCtx {
    return { send: mock(() => Promise.resolve(sentMessage())) };
  }

  function run(ctx: FakeCtx) {
    return handleIntentEditInstruction(stub(ctx), 'rename the phrases', session(), stub({ intentRepo }));
  }

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    intentRepo = new IntentRepository(db);
    intentId = intentRepo.create({
      canonical_name: 'edit_me',
      phrases: ['old'],
      pattern: '(\\d+)',
      workflow: { steps: [{ respond: 'hi {{$1}}' }] },
      format: 'text',
    });
    stream = spyOn(streaming, 'aiStreamRound');
  });

  afterEach(() => {
    stream.mockRestore();
  });

  test('retries an unparseable model answer and applies the first parseable one', async () => {
    stream
      .mockResolvedValueOnce(answer('not json at all'))
      .mockResolvedValueOnce(answer('```json\n{"phrases":["new one","new two"]}\n```'));
    const ctx = makeCtx();

    await run(ctx);

    expect(stream).toHaveBeenCalledTimes(2);
    expect(JSON.parse(intentRepo.getById(intentId)!.phrases)).toEqual(['new one', 'new two']);
    const [preview] = ctx.send.mock.calls[0] as unknown as [string];
    expect(preview).toContain(`Intent #${intentId} updated`);
    expect(preview).toContain('"new one", "new two"');
  });

  test('gives up after three failed attempts and reports the last error without touching the intent', async () => {
    stream.mockResolvedValue(answer(''));
    const ctx = makeCtx();

    await run(ctx);

    expect(stream).toHaveBeenCalledTimes(3);
    expect(JSON.parse(intentRepo.getById(intentId)!.phrases)).toEqual(['old']);
    const [message] = ctx.send.mock.calls[0] as unknown as [string];
    expect(message).toStartWith('Failed to process edit:');
    expect(message).toContain('Empty AI response');
  });

  test('a pattern-only edit is validated against the retained workflow and rejected when it breaks it', async () => {
    // The retained workflow references {{$1}}; a pattern without capture groups invalidates it.
    stream.mockResolvedValue(answer('{"pattern":"no groups here"}'));
    const ctx = makeCtx();

    await run(ctx);

    expect(intentRepo.getById(intentId)!.pattern).toBe('(\\d+)');
    const [message] = ctx.send.mock.calls[0] as unknown as [string];
    expect(message).toStartWith('❌ Edit rejected');
  });

  test('a phrases-only edit skips workflow validation and leaves other fields as they were', async () => {
    stream.mockResolvedValue(answer('{"phrases":["only phrases"]}'));
    const ctx = makeCtx();

    await run(ctx);

    const stored = intentRepo.getById(intentId)!;
    expect(JSON.parse(stored.phrases)).toEqual(['only phrases']);
    expect(stored.pattern).toBe('(\\d+)');
    expect(stored.format).toBe('text');
  });
});

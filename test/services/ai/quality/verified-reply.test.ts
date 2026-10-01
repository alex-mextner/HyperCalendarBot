import { describe, expect, mock, test } from 'bun:test';
import type { Bot } from 'gramio';
import type { QualityAssessment } from '../../../../src/services/ai/quality/answer-quality.ts';
import { type ReplySnapshot, VerifiedReplyDelivery } from '../../../../src/services/ai/quality/verified-reply.ts';
import { createTelegramSender } from '../../../../src/services/ai/telegram-sender.ts';

const scope = { actorId: 123, chatId: -555, turnId: 'turn-1', evidenceRevision: 'read-101-v1' };
function assessment(s: ReplySnapshot, clean = true): QualityAssessment {
  return {
    binding: s.binding,
    taskFulfilled: 'passed',
    factsSupported: 'passed',
    scopeRespected: 'passed',
    noUnsafeActions: 'passed',
    noCosmeticDefects: clean ? 'passed' : 'failed',
    violations: clean ? [] : ['cosmetic_tone'],
  };
}
function harness() {
  const send = mock(async (_chat: number, _text: string) => ({ message_id: 42 }));
  const edit = mock(async (_chat: number, _id: number, _text: string) => {});
  const assess = mock(async (s: ReplySnapshot) => assessment(s, s.text === 'Готово.'));
  const polish = mock(async (_s: ReplySnapshot, _signal: AbortSignal) => 'Готово.');
  const isCurrent = mock(() => true);
  return {
    send,
    edit,
    assess,
    polish,
    isCurrent,
    dependencies: { sender: { sendMessage: send, editMessageText: edit }, assess, polish, isCurrent },
  };
}
describe('verified delivery then cosmetic-only edit', () => {
  test('first send precedes polishing; correction edits exactly the same message', async () => {
    const h = harness(),
      order: string[] = [];
    h.send.mockImplementation(async () => {
      order.push('send');
      return { message_id: 42 };
    });
    h.polish.mockImplementation(async () => {
      order.push('polish');
      expect(h.send).toHaveBeenCalledTimes(1);
      return 'Готово.';
    });
    h.edit.mockImplementation(async () => {
      order.push('edit');
    });
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
    expect(order).toEqual(['send', 'polish', 'edit']);
    expect(h.edit).toHaveBeenCalledWith(-555, 42, 'Готово.');
    expect(r.delivery).toBe('confirmed');
    expect(r.correction).toBe('applied');
    expect(r.lastConfirmedText).toBe('Готово.');
    expect(h.assess).toHaveBeenCalledTimes(2);
  });
  test('clean answer needs neither polishing nor extra quality call', async () => {
    const h = harness();
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово.', timeoutMs: 500 }, h.dependencies).deliver();
    expect(r.correction).toBe('not_needed');
    expect(h.assess).toHaveBeenCalledTimes(1);
    expect(h.polish).not.toHaveBeenCalled();
  });
  test('failed fact check prevents even the initial message', async () => {
    const h = harness();
    h.assess.mockImplementation(async (s) => ({ ...assessment(s), factsSupported: 'failed' }));
    const r = await new VerifiedReplyDelivery({ scope, text: 'wrong', timeoutMs: 500 }, h.dependencies).deliver();
    expect(r.delivery).toBe('not_sent');
    expect(h.send).not.toHaveBeenCalled();
    expect(h.polish).not.toHaveBeenCalled();
  });
  test('unknown evidence cannot be sent as a provisional fact', async () => {
    const h = harness();
    h.assess.mockImplementation(async (s) => ({ ...assessment(s), factsSupported: 'unknown' }));
    await new VerifiedReplyDelivery({ scope, text: 'maybe', timeoutMs: 500 }, h.dependencies).deliver();
    expect(h.send).not.toHaveBeenCalled();
  });
  test('same delivery instance cannot send twice when callers race', async () => {
    const h = harness();
    const op = new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies);
    await Promise.all([op.deliver(), op.deliver(), op.deliver()]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.edit).toHaveBeenCalledTimes(1);
  });
  test('same delivery instance returns retained result after completion', async () => {
    const h = harness();
    const op = new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies);
    expect(await op.deliver()).toEqual(await op.deliver());
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  test('fact-changing polishing is rejected by a fresh trusted assessment', async () => {
    const h = harness();
    h.polish.mockImplementation(async () => 'Встреча в 19:00.');
    h.assess.mockImplementation(async (s) =>
      s.text.includes('19:00')
        ? { ...assessment(s), factsSupported: 'failed', violations: ['fact_mismatch'] }
        : assessment(s, false),
    );
    const r = await new VerifiedReplyDelivery(
      { scope, text: 'Встреча в 13:00.', timeoutMs: 500 },
      h.dependencies,
    ).deliver();
    expect(r.delivery).toBe('confirmed');
    expect(r.correction).toBe('rejected');
    expect(r.lastConfirmedText).toBe('Встреча в 13:00.');
    expect(h.edit).not.toHaveBeenCalled();
  });
  test('old draft approval cannot bless the new output', async () => {
    const h = harness();
    let old: QualityAssessment | undefined;
    h.assess.mockImplementation(async (s) => {
      if (!old) {
        old = assessment(s, false);
        return old;
      }
      return { ...old, noCosmeticDefects: 'passed', violations: [] };
    });
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
    expect(r.correction).toBe('rejected');
    expect(h.edit).not.toHaveBeenCalled();
  });
  test('only text, binding and signal reach the polisher, not business capabilities', async () => {
    const h = harness();
    h.polish.mockImplementation(async (s, signal) => {
      expect(Object.keys(s).sort()).toEqual(['binding', 'text']);
      expect(Object.isFrozen(s)).toBe(true);
      expect(Object.isFrozen(s.binding)).toBe(true);
      expect(signal).toBeInstanceOf(AbortSignal);
      return 'Готово.';
    });
    await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
  });
  test('caller mutations cannot redirect a reply after construction', async () => {
    const h = harness();
    const mutable = { ...scope };
    const request = { scope: mutable, text: 'Готово!', timeoutMs: 500 };
    const op = new VerifiedReplyDelivery(request, h.dependencies);
    mutable.chatId = -999;
    request.text = 'other';
    await op.deliver();
    expect(h.send).toHaveBeenCalledWith(-555, 'Готово!');
    expect(h.edit).toHaveBeenCalledWith(-555, 42, 'Готово.');
  });
  test('new turn before delivery results in no send', async () => {
    const h = harness();
    h.isCurrent.mockReturnValue(false);
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
    expect(r.delivery).toBe('not_sent');
    expect(h.send).not.toHaveBeenCalled();
  });
  test('a new turn while polishing prevents stale edit', async () => {
    const h = harness();
    h.polish.mockImplementation(async () => {
      h.isCurrent.mockReturnValue(false);
      return 'Готово.';
    });
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
    expect(r.correction).toBe('stale');
    expect(h.edit).not.toHaveBeenCalled();
  });
  test('current check is repeated after assessment, before send', async () => {
    const h = harness();
    h.assess.mockImplementation(async (s) => {
      h.isCurrent.mockReturnValue(false);
      return assessment(s);
    });
    await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
    expect(h.send).not.toHaveBeenCalled();
  });
  test('evidence invalidated during recheck prevents stale edit', async () => {
    const h = harness();
    h.assess.mockImplementation(async (s) => {
      if (s.text === 'Готово.') h.isCurrent.mockReturnValue(false);
      return assessment(s, s.text === 'Готово.');
    });
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
    expect(r.correction).toBe('stale');
    expect(h.edit).not.toHaveBeenCalled();
  });
  test('a blocked correction leaves the verified original and sends no fallback', async () => {
    const h = harness();
    h.polish.mockImplementation(async () => {
      throw new Error('provider contains private text');
    });
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
    expect(r.delivery).toBe('confirmed');
    expect(r.correction).toBe('failed');
    expect(r.lastConfirmedText).toBe('Готово!');
    expect(JSON.stringify(r)).not.toContain('private text');
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  test('no corrector configured is explicit,not clean cosmetic success', async () => {
    const h = harness();
    const r = await new VerifiedReplyDelivery(
      { scope, text: 'Готово!', timeoutMs: 500 },
      { ...h.dependencies, polish: undefined },
    ).deliver();
    expect(r.delivery).toBe('confirmed');
    expect(r.correction).toBe('not_attempted');
  });
  for (const text of ['', 'x'.repeat(4097)])
    test(`invalid text length ${text.length} is never sent`, async () => {
      const h = harness();
      const r = await new VerifiedReplyDelivery({ scope, text, timeoutMs: 500 }, h.dependencies).deliver();
      expect(r.delivery).toBe('not_sent');
      expect(h.send).not.toHaveBeenCalled();
    });
  test('empty proposed correction does not erase an answer', async () => {
    const h = harness();
    h.polish.mockImplementation(async () => '');
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
    expect(r.correction).toBe('rejected');
    expect(h.edit).not.toHaveBeenCalled();
  });
  test('unchanged correction performs no unnecessary Telegram edit', async () => {
    const h = harness();
    h.polish.mockImplementation(async () => 'Готово!');
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
    expect(r.correction).toBe('unchanged');
    expect(h.edit).not.toHaveBeenCalled();
  });
  test('uncertain send outcome is not retried or followed by edit', async () => {
    const h = harness();
    h.send.mockImplementation(async () => {
      throw new Error('unknown upstream result');
    });
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
    expect(r.delivery).toBe('unknown');
    expect(r.lastConfirmedText).toBeNull();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.polish).not.toHaveBeenCalled();
  });
  test('uncertain edit outcome retains last confirmed text without a new message', async () => {
    const h = harness();
    h.edit.mockImplementation(async () => {
      throw new Error('connection lost');
    });
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
    expect(r.delivery).toBe('confirmed');
    expect(r.correction).toBe('unknown');
    expect(r.lastConfirmedText).toBe('Готово!');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.edit).toHaveBeenCalledTimes(1);
  });
  test('pre-aborted parent never invokes assessor or sends a message', async () => {
    const h = harness();
    const r = await new VerifiedReplyDelivery(
      { scope, text: 'Готово!', timeoutMs: 500, signal: AbortSignal.abort() },
      h.dependencies,
    ).deliver();
    expect(r.delivery).toBe('not_sent');
    expect(h.assess).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
  test('hung polishing is bounded and its late answer cannot edit', async () => {
    const h = harness(),
      deferred = Promise.withResolvers<string>();
    h.polish.mockImplementation(() => deferred.promise);
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 25 }, h.dependencies).deliver();
    expect(r.delivery).toBe('confirmed');
    expect(r.correction).toBe('timed_out');
    deferred.resolve('Готово.');
    await Bun.sleep(5);
    expect(h.edit).not.toHaveBeenCalled();
  });
  test('hung send may have delivered and is reported unknown,not safe to resend', async () => {
    const h = harness(),
      deferred = Promise.withResolvers<{ message_id: number }>();
    h.send.mockImplementation(() => deferred.promise);
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 25 }, h.dependencies).deliver();
    expect(r.delivery).toBe('unknown');
    deferred.resolve({ message_id: 42 });
    await Bun.sleep(5);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.edit).not.toHaveBeenCalled();
  });
  test('assessor outage cannot approve a reply', async () => {
    const h = harness();
    h.assess.mockImplementation(async () => {
      throw new Error('outage');
    });
    const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
    expect(r.delivery).toBe('not_sent');
    expect(h.send).not.toHaveBeenCalled();
  });
  test('uses the real TelegramSender adapter without mode changes or keyboards', async () => {
    const h = harness(),
      apiSend = mock(async (_p: { chat_id: number; text: string }) => ({ message_id: 88 })),
      apiEdit = mock(async (_p: { chat_id: number; message_id: number; text: string }) => true);
    const bot = { api: { sendMessage: apiSend, editMessageText: apiEdit } } as unknown as Bot;
    const r = await new VerifiedReplyDelivery(
      { scope, text: 'Готово!', timeoutMs: 500 },
      { ...h.dependencies, sender: createTelegramSender(bot) },
    ).deliver();
    expect(apiSend).toHaveBeenCalledWith({ chat_id: -555, text: 'Готово!' });
    expect(apiEdit).toHaveBeenCalledWith({ chat_id: -555, message_id: 88, text: 'Готово.' });
    expect(r.messageId).toBe(88);
  });
});
test('caller cancellation during polishing is distinct from timeout', async () => {
  const h = harness(),
    controller = new AbortController();
  h.polish.mockImplementation(async () => {
    controller.abort(new DOMException('User cancelled', 'AbortError'));
    return new Promise<string>(() => {});
  });
  const r = await new VerifiedReplyDelivery(
    { scope, text: 'Готово!', timeoutMs: 500, signal: controller.signal },
    h.dependencies,
  ).deliver();
  expect(r.delivery).toBe('confirmed');
  expect(r.correction).toBe('cancelled');
  expect(h.edit).not.toHaveBeenCalled();
});
test('invalid send receipt has a distinct reason and is never retried', async () => {
  const h = harness();
  h.send.mockImplementation(async () => ({ message_id: 0 }));
  const r = await new VerifiedReplyDelivery({ scope, text: 'Готово!', timeoutMs: 500 }, h.dependencies).deliver();
  expect(r.delivery).toBe('unknown');
  expect(r.reasons).toEqual(['invalid_delivery_receipt']);
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.polish).not.toHaveBeenCalled();
});

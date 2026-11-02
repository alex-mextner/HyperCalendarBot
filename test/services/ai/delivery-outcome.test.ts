// The delivery outcome of a reply is what the Telegram API answered: message ids and a result that
// tells a delivered, edited, failed or unknown send apart (production, 2026-11-01: the logs said
// "delivered" for a notice nobody could trace to a message).
import { beforeEach, describe, expect, type Mock, mock, test } from 'bun:test';
import { RunIncidentReporter } from '../../../src/services/ai/agent/run-incident.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { createAgentRunFixture, makeStreamImpl } from './agent-run-helpers.ts';

const PLACEHOLDER_ID = 4101;

describe('delivery outcome from the Telegram API results', () => {
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;
  let sendMessage: Mock<TelegramSender['sendMessage']>;
  let editMessageText: Mock<TelegramSender['editMessageText']>;

  beforeEach(() => {
    ({ ctx, config } = createAgentRunFixture());
    sendMessage = mock(async () => ({ message_id: PLACEHOLDER_ID }));
    editMessageText = mock(async () => undefined);
    sender = { sendMessage, editMessageText } as unknown as TelegramSender;
  });

  const answer = () => makeStreamImpl([{ kind: 'text', text: 'Hello there.' }]).impl;
  const run = () => new CalendarBotAgent(config, sender, { streamImpl: answer() }).run(ctx);

  test('a placeholder edited into the reply is "edited" and names the message', async () => {
    const result = await run();
    expect(result.metrics).toMatchObject({
      deliveryOutcome: 'edited',
      deliveredMessageCount: 1,
      deliveredMessageIds: [PLACEHOLDER_ID],
    });
  });

  test('a final edit Telegram rejects is "failed", never "delivered"', async () => {
    editMessageText.mockImplementation(async () => {
      throw new Error('Bad Request: message to edit not found');
    });
    const result = await run();
    expect(result.metrics?.deliveryOutcome).toBe('failed');
    expect(result.metrics?.deliveredMessageIds).toEqual([]);
  });

  test('"message is not modified" still counts as shown', async () => {
    editMessageText.mockImplementation(async () => {
      throw new Error('Bad Request: message is not modified');
    });
    const result = await run();
    expect(result.metrics?.deliveryOutcome).toBe('edited');
  });

  test('a send answered without a usable message id is "unknown"', async () => {
    // Telegram answered 200 without the message object: a malformed answer the types forbid.
    sendMessage.mockImplementation(async () => ({}) as unknown as { message_id: number });
    const result = await run();
    expect(result.metrics?.deliveryOutcome).toBe('unknown');
    expect(result.metrics?.deliveredMessageCount).toBe(0);
  });

  test('a reply longer than one message reports every message it created', async () => {
    let next = PLACEHOLDER_ID;
    sendMessage.mockImplementation(async () => ({ message_id: next++ }));
    const long = Array.from({ length: 700 }, (_, i) => `Line number ${i} of a very long synthetic reply.`).join('\n');
    const impl = makeStreamImpl([{ kind: 'text', text: long }]).impl;
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.metrics?.deliveryOutcome).toBe('edited');
    const ids = result.metrics?.deliveredMessageIds ?? [];
    // The placeholder is edited; every overflow chunk is a new message with the id Telegram returned.
    expect(ids.length).toBeGreaterThan(2);
    expect(ids).toEqual(ids.map((_, index) => PLACEHOLDER_ID + index));
    expect(result.metrics?.deliveredMessageCount).toBe(ids.length);
  });

  test('an incident alert carries the delivery outcome and message ids, nothing else about the chat', async () => {
    const alerts: string[] = [];
    config.runIncidents = new RunIncidentReporter((text) => alerts.push(text));
    const failing = makeStreamImpl([{ kind: 'error', error: new Error('provider down') }]).impl;
    const result = await new CalendarBotAgent(config, sender, { streamImpl: failing }).run(ctx);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(
      `delivery: ${result.metrics?.deliveryOutcome} messages=${result.metrics?.deliveredMessageCount}`,
    );
    if (result.metrics?.deliveredMessageIds.length) {
      expect(alerts[0]).toContain(`ids=${result.metrics.deliveredMessageIds.join(',')}`);
    }
  });
});

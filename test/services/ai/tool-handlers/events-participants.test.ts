// event tool handlers: participant info on update and notify_participants.
import { beforeEach, describe, expect, test } from 'bun:test';
import { ParticipantRepository } from '../../../../src/database/repositories/participant.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { handleNotifyParticipants, handleUpdateEvent } from '../../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { createEventToolFixture, type EventToolFixture, USER_ID } from './events-fixtures.ts';

describe('event tool handlers', () => {
  let db: EventToolFixture['db'];
  let ctx: AgentContext;

  beforeEach(() => {
    ({ db, ctx } = createEventToolFixture());
  });

  describe('handleUpdateEvent — participant info', () => {
    test('output mentions participant count when event has accepted participants', async () => {
      const participantRepo = new ParticipantRepository(db);
      const otherUserId = 999;
      const userRepo = new UserRepository(db);
      userRepo.create({ telegram_id: otherUserId, timezone: 'UTC' });

      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Shared Meeting',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      participantRepo.add(event.id, otherUserId, 'accepted');

      const ctxWithParticipants = { ...ctx, participantRepo };
      const result = await handleUpdateEvent(ctxWithParticipants, {
        event_id: event.id,
        title: 'Renamed Meeting',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('1 participant');
      expect(result.output).toContain('notify');
    });

    test('output does not mention participants when event has none', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Solo Event',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });

      const ctxWithParticipants = { ...ctx, participantRepo };
      const result = await handleUpdateEvent(ctxWithParticipants, {
        event_id: event.id,
        title: 'Still Solo',
      });
      expect(result.success).toBe(true);
      expect(result.output).not.toContain('participant');
    });
  });

  describe('handleNotifyParticipants', () => {
    test('sends message to accepted participants', async () => {
      const participantRepo = new ParticipantRepository(db);
      const otherUserId = 999;
      const userRepo = new UserRepository(db);
      userRepo.create({ telegram_id: otherUserId, timezone: 'UTC' });

      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Standup',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      participantRepo.add(event.id, otherUserId, 'accepted');

      const enqueuedBatches: { recipientId: number; text: string; origin: string }[][] = [];
      const ctxWithBroadcast = {
        ...ctx,
        participantRepo,
        broadcast: {
          enqueue: async () => {},
          enqueueBatch: async (items: { recipientId: number; text: string; origin: string }[]) => {
            enqueuedBatches.push(items);
          },
        },
      };

      const result = await handleNotifyParticipants(ctxWithBroadcast, {
        event_id: event.id,
        message: 'Meeting moved to 11:00',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('1 participant');
      expect(enqueuedBatches).toHaveLength(1);
      expect(enqueuedBatches[0]).toHaveLength(1);
      expect(enqueuedBatches[0]![0]!.recipientId).toBe(otherUserId);
      expect(enqueuedBatches[0]![0]!.text).toContain('Meeting moved to 11:00');
    });

    test('returns error when event not found', async () => {
      const result = await handleNotifyParticipants(ctx, {
        event_id: 9999,
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('returns error when no participants', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Solo',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });

      const ctxWithParticipants = {
        ...ctx,
        participantRepo,
        broadcast: { enqueue: async () => {}, enqueueBatch: async () => {} },
      };
      const result = await handleNotifyParticipants(ctxWithParticipants, {
        event_id: event.id,
        message: 'Test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('no accepted participants');
    });
  });
});

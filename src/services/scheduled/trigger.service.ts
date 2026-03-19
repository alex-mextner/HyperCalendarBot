import { logger } from '../../utils/logger.ts';
import { evaluate } from '../intent/expression-evaluator.ts';
import { ALL_TOPICS, type DomainEventBus, type DomainEventMap, type DomainEventTopic } from './domain-event-bus.ts';
import type { TriggerRepository } from './trigger.repository.ts';

const triggerLogger = logger.child({ module: 'trigger-service' });

export interface AiMessageJobData {
  userId: number;
  message: string;
  source: 'scheduled' | 'trigger';
  scheduleId?: string;
  triggerId?: string;
}

export class TriggerService {
  constructor(
    private bus: DomainEventBus,
    private repo: TriggerRepository,
    private pushToQueue: (data: AiMessageJobData) => Promise<void>,
  ) {}

  subscribe(): void {
    for (const topic of ALL_TOPICS) {
      this.bus.on(topic, (payload) => {
        this.handleEvent(topic, payload as DomainEventMap[DomainEventTopic]).catch((err: unknown) => {
          triggerLogger.error({ err, topic }, 'TriggerService: unhandled error in handleEvent');
        });
      });
    }
  }

  private async handleEvent(topic: DomainEventTopic, payload: DomainEventMap[DomainEventTopic]): Promise<void> {
    const { userId } = payload;
    const triggers = this.repo.findEnabled(userId, topic);
    if (triggers.length === 0) return;

    for (const trigger of triggers) {
      if (trigger.condition) {
        try {
          const passes = evaluate(trigger.condition, payload as Record<string, unknown>);
          if (!passes) continue;
        } catch (err: unknown) {
          triggerLogger.warn(
            { err, triggerId: trigger.id, condition: trigger.condition },
            'Condition eval failed, skipping',
          );
          continue;
        }
      }

      // Commit DB state BEFORE pushing to queue (once = no double-fire)
      this.repo.recordFire(trigger.id, trigger.once === 1);

      try {
        await this.pushToQueue({
          userId,
          message: trigger.action,
          source: 'trigger',
          triggerId: trigger.id,
        });
      } catch (err: unknown) {
        triggerLogger.error({ err, triggerId: trigger.id }, 'Failed to push trigger action to queue — action lost');
      }
    }
  }
}

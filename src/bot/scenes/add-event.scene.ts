// src/bot/scenes/add-event.scene.ts

import { Scene } from '@gramio/scenes';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { LocationVerificationService } from '../../services/location/location-verification-service.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';
import { type AddEventDeps, runAddEventStep } from './add-event-steps.ts';
import type { AddEventParams, AddEventState } from './types.ts';

export { applyDefaultDuration, parseWizardDateTime } from './add-event-input.ts';

const WIZARD_STEP_COUNT = 8;

export function createAddEventScene(
  eventService: EventService,
  userComposer: UserResolverComposer,
  actionLogRepo?: ActionLogRepository,
  onEventCreated?: (userId: number, eventId: number) => Promise<void>,
  locationVerification?: Pick<LocationVerificationService, 'verifyEventLocation'>,
) {
  const deps: AddEventDeps = {
    eventService,
    actionLogRepo,
    onEventCreated,
    locationVerification,
    submissions: new Map<string, Promise<number>>(),
  };
  const scene = new Scene('add_event').params<AddEventParams>().state<AddEventState>().extend(userComposer);
  for (let step = 0; step < WIZARD_STEP_COUNT; step++) {
    scene.step(['message', 'callback_query'], async (context) => {
      const { lang, dbUser: user } = context;
      if (!user) return;
      const state = context.scene.state;
      const params = context.scene.params;
      await runAddEventStep(
        {
          step,
          firstTime: context.scene.step.firstTime,
          lang,
          user,
          state,
          params,
          timezone: state.timezone ?? params?.timezone ?? user.timezone,
          chatId: context.chatId,
          message: context.is('message') ? { text: context.text } : undefined,
          callback: context.is('callback_query')
            ? {
                data: context.data ?? '',
                messageId: context.message?.id,
                answer: (text) => (text === undefined ? context.answer() : context.answer({ text })),
              }
            : undefined,
          send: (text, options) => context.send(text, options),
          update: (patch, options) => (options ? context.scene.update(patch, options) : context.scene.update(patch)),
          goTo: (target) => context.scene.step.go(target, true),
          exit: () => context.scene.exit(),
        },
        deps,
      );
    });
  }
  return scene;
}

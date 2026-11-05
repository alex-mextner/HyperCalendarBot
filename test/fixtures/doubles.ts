// Where a hand-built test double is told it is the production type it stands in for.
// A double implements only what the code under test touches, so the compiler cannot prove it
// matches the full interface; naming the cast here keeps it out of every call site.
import type { BotCallbackContext, BotCommandContext } from '../../src/bot/types.ts';
import type { EventService } from '../../src/services/event/event-service.ts';

export const asCommandContext = (double: unknown): BotCommandContext => double as BotCommandContext;

export const asCallbackContext = (double: unknown): BotCallbackContext => double as BotCallbackContext;

export const asEventService = (double: unknown): EventService => double as EventService;

export const asDouble = <T>(double: unknown): T => double as T;

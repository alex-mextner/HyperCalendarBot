// src/services/ai/chat-turn-context.ts
//
// Which reserved place in its chat's line the code running right now is answering. The chat-logging
// middleware reserves the place when it saves a user message and runs the rest of that update's handling
// inside `withChatTurn`; whatever agent run the update starts (the text pipeline, /cal, a button) finds it with
// `currentChatTurn` and takes it over, with no id passed along. A run started elsewhere (scheduled, retry,
// supplement of another update) finds none and joins the end of the line without a message of its own.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatTurnReservation } from './chat-run-gate.ts';

const current = new AsyncLocalStorage<ChatTurnReservation>();

export function withChatTurn<T>(reservation: ChatTurnReservation, work: () => T): T {
  return current.run(reservation, work);
}

export function currentChatTurn(): ChatTurnReservation | undefined {
  return current.getStore();
}

// src/bot/pipeline/types.ts

import type { Workflow } from '../../services/intent/workflow-schema.ts';
import type { BotCommandContext } from '../types.ts';

export interface WorkflowSession {
  intentId: number;
  stepIndex: number;
  stepResults: { [key: string]: unknown };
  workflow: Workflow;
  captures: { [key: string]: string };
  createdAt: number;
}

export interface WorkflowSessionStore {
  get(chatId: number, userId: number): WorkflowSession | null;
  set(chatId: number, userId: number, session: WorkflowSession): void;
  delete(chatId: number, userId: number): void;
  /** Delete all sessions for a user across all chats (e.g. when user blocks the bot). */
  deleteByUser(userId: number): void;
}

export interface FeedbackThreadContext {
  threadId: number;
  subject: string;
  messages: { sender: string; text: string }[];
}

export type PipelineResult =
  | { handled: true }
  | { handled: true; needsSupplement: true; supplementAutoResponse: string }
  | { handled: false }
  | { handled: false; feedbackContext: FeedbackThreadContext };

export interface GroupContext {
  isGroup: boolean;
  groupChatId?: number;
  groupTitle?: string;
  onBotResponse?: (messageId: number) => void;
}

export type PipelineLayer = (
  ctx: BotCommandContext,
  messageText: string,
  extra?: {
    feedbackContext?: FeedbackThreadContext;
    groupContext?: GroupContext;
    supplementMode?: boolean;
    supplementAutoResponse?: string;
  },
) => Promise<PipelineResult>;

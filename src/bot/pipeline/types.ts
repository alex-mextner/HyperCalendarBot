// src/bot/pipeline/types.ts

import type { StepResults } from '../../database/repositories/workflow-session.repository.ts';
import type { Workflow } from '../../services/intent/workflow-schema.ts';
import type { BotCommandContext } from '../types.ts';

export interface WorkflowSession {
  intentId: number;
  stepIndex: number;
  stepResults: StepResults;
  workflow: Workflow;
  captures: { [key: string]: string };
  createdAt: number;
  /** Original actor-written request, never generated tool arguments. */
  sourceMessage?: string;
  /** Unconfirmed prompt delivery must be retried, never treated as an answer. */
  pendingPrompt?: { text: string; options?: string[]; delivered: boolean };
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
  topicThreadId?: number;
  onBotResponse?: (messageId: number) => void;
}

export type PipelineLayer = (
  ctx: BotCommandContext,
  messageText: string,
  extra?: {
    feedbackContext?: FeedbackThreadContext;
    groupContext?: GroupContext;
    incomingMessageId?: number;
    supplementMode?: boolean;
    supplementAutoResponse?: string;
    /** True when the user explicitly addressed the bot (DM, @mention, "Бот,", reply).
     *  False for keyword-only or session-continuation group messages. */
    wasExplicitInvocation?: boolean;
    /** Retry attempt index passed from the queue job. Absent on original user messages. */
    retryAttempt?: number;
  },
) => Promise<PipelineResult>;

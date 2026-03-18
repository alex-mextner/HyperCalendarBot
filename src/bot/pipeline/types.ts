// src/bot/pipeline/types.ts

import type { BotCommandContext } from '../types.ts';

export interface FeedbackThreadContext {
  threadId: number;
  subject: string;
  messages: { sender: string; text: string }[];
}

export type PipelineResult =
  | { handled: true }
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
  extra?: { feedbackContext?: FeedbackThreadContext; groupContext?: GroupContext },
) => Promise<PipelineResult>;

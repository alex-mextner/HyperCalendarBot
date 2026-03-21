// src/bot/agent-context-factory.ts
// Shared type for the agentContextBuilder function.
// Implementation: buildAgentContextFactory() in src/bot/handlers/message.handler.ts
// This file exists so worker code can import the type without depending on GramIO.

import type { User } from '../database/types.ts';
import type { AgentContext } from '../services/ai/types.ts';

export type AgentContextBuilder = (
  user: User,
  chatId: number,
  messageText: string,
  groupInfo?: {
    isGroup: boolean;
    groupChatId?: number;
    groupTitle?: string;
    onBotResponse?: (messageId: number) => void;
    incomingMessageId?: number;
  },
) => AgentContext;

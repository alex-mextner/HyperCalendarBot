// src/bot/handlers/agent-continuation.ts
// Runs the AI on a turn the bot writes for the user (e.g. a pressed confirmation button).

import type { User } from '../../database/types.ts';
import type { CalendarBotAgent } from '../../services/ai/agent.ts';
import type { AgentContext } from '../../services/ai/types.ts';

/** What a bot-authored continuation needs to hand a turn to the AI. */
export interface AgentContinuationDeps {
  agent: Pick<CalendarBotAgent, 'run'>;
  buildContext: (
    user: User,
    chatId: number,
    messageText: string,
    groupInfo?: { isGroup: boolean; groupChatId?: number },
  ) => AgentContext;
}

/**
 * Continue the conversation with a message the bot composed on the user's behalf. The message is
 * saved to chat_history first, like any user turn: the agent reads the current turn from history,
 * so an unsaved message never reaches the model and is missing from later turns too. The explicit
 * chatHistoryId links this turn's tool calls to that row instead of the previous message. A chat
 * other than the user's own private chat is a group.
 */
export async function continueWithAgent(
  user: User,
  text: string,
  deps: AgentContinuationDeps,
  chatId = user.telegram_id,
): Promise<void> {
  const groupInfo = chatId === user.telegram_id ? undefined : { isGroup: true, groupChatId: chatId };
  const ctx = deps.buildContext(user, chatId, text, groupInfo);
  // Private turns are stored without a chat id, like the logging middleware stores them.
  const chatHistoryId = ctx.conversationLogger.logUserMessage(user.telegram_id, text, groupInfo ? chatId : undefined);
  await deps.agent.run({ ...ctx, chatHistoryId });
}

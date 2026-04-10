import type OpenAI from 'openai';
import type { ChatHistoryRepository } from '../database/repositories/chat-history.repository.ts';

export class ConversationLogger {
  constructor(private repo: ChatHistoryRepository) {}

  logUserMessage(userId: number, text: string, chatId?: number): number {
    return this.repo.save(userId, 'user', text, chatId);
  }

  logBotResponse(userId: number, text: string, chatId?: number): void {
    this.repo.save(userId, 'assistant', JSON.stringify({ kind: 'bot', text }), chatId);
  }

  logCommand(userId: number, name: string, args?: string, chatId?: number): void {
    this.repo.save(userId, 'user', JSON.stringify({ kind: 'command', name, ...(args && { args }) }), chatId);
  }

  logButtonPress(userId: number, label: string, detail?: string, chatId?: number): void {
    this.repo.save(userId, 'user', JSON.stringify({ kind: 'button', label, detail }), chatId);
  }

  logBotEdit(userId: number, text: string, chatId?: number): void {
    this.repo.save(userId, 'assistant', JSON.stringify({ kind: 'bot_edit', text }), chatId);
  }

  logEditedMessage(userId: number, text: string, chatId?: number): void {
    this.repo.save(userId, 'user', JSON.stringify({ kind: 'edited', text }), chatId);
  }

  /**
   * Persist an assistant turn produced by aiStreamRound as JSON under role='assistant'.
   * The agent's buildMessages parses it back via StoredAssistantMessageSchema.
   */
  logAiTurn(userId: number, message: OpenAI.ChatCompletionMessageParam, chatId?: number): void {
    this.repo.save(userId, 'assistant', JSON.stringify(message), chatId);
  }

  /**
   * Persist an array of tool-role messages (the tool results for one round) as JSON
   * under role='tool'. Stored as an array so parseHistoryRow can expand it back into
   * multiple MessageParam entries on read.
   */
  logToolResults(userId: number, results: OpenAI.ChatCompletionMessageParam[], chatId?: number): void {
    this.repo.save(userId, 'tool', JSON.stringify(results), chatId);
  }
}

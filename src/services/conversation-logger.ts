import type Anthropic from '@anthropic-ai/sdk';
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

  logAiTurn(userId: number, blocks: Anthropic.ContentBlockParam[], chatId?: number): void {
    this.repo.save(userId, 'assistant', JSON.stringify(blocks), chatId);
  }

  logToolResults(userId: number, results: Anthropic.ToolResultBlockParam[], chatId?: number): void {
    this.repo.save(userId, 'tool', JSON.stringify(results), chatId);
  }
}

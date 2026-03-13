import type { ChatHistoryRepository } from '../../database/repositories/chat-history.repository.ts';
import type { ReminderRepository } from '../../database/repositories/reminder.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../event/event-service.ts';
import type { HolidayService } from '../holiday/holiday-service.ts';

export interface AgentContext {
  user: User;
  chatId: number;
  messageText: string;
  eventService: EventService;
  holidayService: HolidayService;
  chatHistory: ChatHistoryRepository;
  userRepo: UserRepository;
  reminderRepo: ReminderRepository;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface TelegramSender {
  sendMessage(chatId: number, text: string, parseMode?: string): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, parseMode?: string): Promise<void>;
}

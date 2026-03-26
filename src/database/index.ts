// src/database/index.ts
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbLogger } from '../utils/logger.ts';
import { migrations } from './migrations.ts';
import { ActionLogRepository } from './repositories/action-log.repository.ts';
import { BirthdayMetadataRepository } from './repositories/birthday-metadata.repository.ts';
import { CalendarProposalRepository } from './repositories/calendar-proposal.repository.ts';
import { CallLogRepository } from './repositories/call-log.repository.ts';
import { CallSettingsRepository } from './repositories/call-settings.repository.ts';
import { ChatHistoryRepository } from './repositories/chat-history.repository.ts';
import { ContactRepository } from './repositories/contact.repository.ts';
import { DeepLinkRepository } from './repositories/deep-link.repository.ts';
import { EditProposalRepository } from './repositories/edit-proposal.repository.ts';
import { EventRepository } from './repositories/event.repository.ts';
import { EventReminderRepository } from './repositories/event-reminder.repository.ts';
import { GoogleCalendarRepository } from './repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from './repositories/google-sync.repository.ts';
import { GroupChatRepository } from './repositories/group-chat.repository.ts';
import { GroupMemberRepository } from './repositories/group-member.repository.ts';
import { GroupSessionRepository } from './repositories/group-session.repository.ts';
import { HolidayRepository } from './repositories/holiday.repository.ts';
import { InvitationRepository } from './repositories/invitation.repository.ts';
import { NotificationLogRepository } from './repositories/notification-log.repository.ts';
import { NotificationPreferencesRepository } from './repositories/notification-preferences.repository.ts';
import { ParticipantRepository } from './repositories/participant.repository.ts';
import { ReminderRepository } from './repositories/reminder.repository.ts';
import { SecretaryRepository } from './repositories/secretary.repository.ts';
import { SharedEventRepository } from './repositories/shared-event.repository.ts';
import { SharingSettingsRepository } from './repositories/sharing-settings.repository.ts';
import { UserRepository } from './repositories/user.repository.ts';
import { UserMemoryRepository } from './repositories/user-memory.repository.ts';
import { WorkflowSessionRepository } from './repositories/workflow-session.repository.ts';
import { runMigrations } from './schema.ts';

export class DatabaseService {
  readonly db: Database;
  readonly callSettings: CallSettingsRepository;
  readonly callLog: CallLogRepository;
  readonly users: UserRepository;
  readonly events: EventRepository;
  readonly reminders: ReminderRepository;
  readonly holidays: HolidayRepository;
  readonly chatHistory: ChatHistoryRepository;
  readonly notificationPreferences: NotificationPreferencesRepository;
  readonly eventReminders: EventReminderRepository;
  readonly notificationLog: NotificationLogRepository;
  readonly googleSync: GoogleSyncRepository;
  readonly googleCalendars: GoogleCalendarRepository;
  readonly deepLinks: DeepLinkRepository;
  readonly sharingSettings: SharingSettingsRepository;
  readonly invitations: InvitationRepository;
  readonly sharedEvents: SharedEventRepository;
  readonly groupChats: GroupChatRepository;
  readonly groupMembers: GroupMemberRepository;
  readonly contacts: ContactRepository;
  readonly participants: ParticipantRepository;
  readonly editProposals: EditProposalRepository;
  readonly secretaries: SecretaryRepository;
  readonly calendarProposals: CalendarProposalRepository;
  readonly workflowSessions: WorkflowSessionRepository;
  readonly groupSessions: GroupSessionRepository;
  readonly birthdayMeta: BirthdayMetadataRepository;
  readonly userMemory: UserMemoryRepository;
  readonly actionLog: ActionLogRepository;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA cache_size = -16000');
    this.db.exec('PRAGMA mmap_size = 268435456');

    dbLogger.info({ path: dbPath }, 'Database opened');

    runMigrations(this.db, migrations);

    this.callSettings = new CallSettingsRepository(this.db);
    this.callLog = new CallLogRepository(this.db);
    this.users = new UserRepository(this.db);
    this.events = new EventRepository(this.db);
    this.reminders = new ReminderRepository(this.db);
    this.holidays = new HolidayRepository(this.db);
    this.chatHistory = new ChatHistoryRepository(this.db);
    this.notificationPreferences = new NotificationPreferencesRepository(this.db);
    this.eventReminders = new EventReminderRepository(this.db);
    this.notificationLog = new NotificationLogRepository(this.db);
    this.googleSync = new GoogleSyncRepository(this.db);
    this.googleCalendars = new GoogleCalendarRepository(this.db);
    this.deepLinks = new DeepLinkRepository(this.db);
    this.sharingSettings = new SharingSettingsRepository(this.db);
    this.invitations = new InvitationRepository(this.db);
    this.sharedEvents = new SharedEventRepository(this.db);
    this.groupChats = new GroupChatRepository(this.db);
    this.groupMembers = new GroupMemberRepository(this.db);
    this.contacts = new ContactRepository(this.db);
    this.participants = new ParticipantRepository(this.db);
    this.editProposals = new EditProposalRepository(this.db);
    this.secretaries = new SecretaryRepository(this.db);
    this.calendarProposals = new CalendarProposalRepository(this.db);
    this.workflowSessions = new WorkflowSessionRepository(this.db);
    this.groupSessions = new GroupSessionRepository(this.db);
    this.birthdayMeta = new BirthdayMetadataRepository(this.db);
    this.userMemory = new UserMemoryRepository(this.db);
    this.actionLog = new ActionLogRepository(this.db);
  }

  close(): void {
    this.db.close();
    dbLogger.info('Database closed');
  }
}

export function createDatabase(dbPath: string): DatabaseService {
  return new DatabaseService(dbPath);
}

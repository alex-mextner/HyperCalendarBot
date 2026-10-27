// Shared in-memory fixture for the sharing tool-handler tests (sharing-*.test.ts): fresh database,
// repositories and services per call, plus a context factory. Each test file calls
// createSharingFixture() from its own beforeEach, exactly as the former single file did.
import { Database } from 'bun:sqlite';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { DeepLinkRepository } from '../../../../src/database/repositories/deep-link.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../../src/database/repositories/invitation.repository.ts';
import { SharedEventRepository } from '../../../../src/database/repositories/shared-event.repository.ts';
import { SharingSettingsRepository } from '../../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';
import { DeepLinkService } from '../../../../src/services/sharing/deep-link-service.ts';
import { InvitationService } from '../../../../src/services/sharing/invitation-service.ts';
import { PrivacyService } from '../../../../src/services/sharing/privacy-service.ts';
import { SharingService } from '../../../../src/services/sharing/sharing-service.ts';

export const USER_ID = 100;
export const OTHER_USER_ID = 200;
export const GROUP_CHAT_ID = -1009999;

export function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

export function futureStartAt(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

export function createSharingFixture(): SharingFixture {
  const db = createTestDb();
  const userRepo = new UserRepository(db);
  const eventRepo = new EventRepository(db);
  const eventReminderRepo = new EventReminderRepository(db);
  const sharedEventRepo = new SharedEventRepository(db);
  const invitationRepo = new InvitationRepository(db);
  const sharingSettingsRepo = new SharingSettingsRepository(db);
  const invitationService = new InvitationService(invitationRepo, eventRepo, sharingSettingsRepo);
  const privacyService = new PrivacyService(sharingSettingsRepo);
  const eventService = new EventService({ eventRepo });
  const sharingService = new SharingService(
    (userId, startUtc, endUtc) => eventService.getEventsInRange(userId, startUtc, endUtc),
    privacyService,
  );
  const deepLinkService = new DeepLinkService(new DeepLinkRepository(db));

  userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
  userRepo.create({ telegram_id: OTHER_USER_ID, timezone: 'UTC' });

  function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
    return {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      // Delivery tests exercise a user-supplied recipient, not an invented global ID.
      messageText: `Invite Telegram ID ${OTHER_USER_ID}`,
      isGroup: false,
      eventService,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: new ChatHistoryRepository(db),
      userRepo,
      eventReminderRepo,
      sharing: {
        sharedEventRepo,
        invitationRepo,
        invitationService,
        sharingSettingsRepo,
        sharingService,
        privacyService,
        editProposalRepo: undefined as never,
      },
      conversationLogger: null as never,
      ...overrides,
    };
  }

  return {
    db,
    userRepo,
    eventRepo,
    eventReminderRepo,
    eventService,
    sharedEventRepo,
    invitationRepo,
    sharingSettingsRepo,
    invitationService,
    sharingService,
    privacyService,
    deepLinkService,
    makeCtx,
  };
}

export interface SharingFixture {
  db: Database;
  userRepo: UserRepository;
  eventRepo: EventRepository;
  eventReminderRepo: EventReminderRepository;
  eventService: EventService;
  sharedEventRepo: SharedEventRepository;
  invitationRepo: InvitationRepository;
  sharingSettingsRepo: SharingSettingsRepository;
  invitationService: InvitationService;
  sharingService: SharingService;
  privacyService: PrivacyService;
  deepLinkService: DeepLinkService;
  makeCtx: (overrides?: Partial<AgentContext>) => AgentContext;
}

// src/bot/scenes/index.ts
import { scenes } from '@gramio/scenes';
import type { DatabaseService } from '../../database/index.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';
import { createAddEventScene } from './add-event.scene.ts';
import { wrapWithChatId } from './chat-scoped-storage.ts';
import type { ConnectTelegramConfig } from './connect-telegram.scene.ts';
import { createConnectTelegramScene } from './connect-telegram.scene.ts';
import { createEditValueScene } from './edit-value.scene.ts';
import { createImportScene } from './import.scene.ts';
import { createOnboardingScene } from './onboarding.scene.ts';
import { createSceneStorage } from './storage.ts';
import { createTimezoneScene } from './timezone.scene.ts';

interface ConnectTelegramSceneDeps {
  invitationService?: InvitationService;
  sendAsConnectedUser?: (
    inviterId: number,
    targetId: number,
    text: string,
    username?: string,
    meta?: { invitationId?: number },
  ) => Promise<boolean>;
  deepLinkService?: DeepLinkService;
  botUsername?: string;
}

export function createScenesPlugin(
  db: DatabaseService,
  eventService: EventService,
  botToken: string,
  userComposer: UserResolverComposer,
  config: ConnectTelegramConfig,
  gcalConfigured = false,
  prefsService?: NotificationPreferencesService,
  holidayService?: HolidayService,
  onEventCreated?: (userId: number, eventId: number) => Promise<void>,
  connectTelegramSceneDeps?: ConnectTelegramSceneDeps,
) {
  const storage = createSceneStorage(db.db);
  // Cast satisfies GramIO's generic Storage<Data> structural contract:
  // wrapWithChatId returns a plain string-keyed interface that is a superset at runtime.
  const scopedStorage = wrapWithChatId(storage) as ReturnType<typeof createSceneStorage>;

  const addEventScene = createAddEventScene(eventService, userComposer, db.actionLog, onEventCreated);
  const editValueScene = createEditValueScene(eventService, userComposer, db.actionLog);
  const importScene = createImportScene(eventService, botToken, userComposer, db.actionLog);
  const timezoneScene = createTimezoneScene(db, userComposer);
  const onboardingScene = createOnboardingScene(
    db,
    userComposer,
    gcalConfigured,
    prefsService,
    holidayService,
    undefined,
    {
      invitationRepo: db.invitations,
      userRepo: db.users,
      eventService,
    },
  );
  const connectTelegramDeps = connectTelegramSceneDeps?.invitationService
    ? {
        eventRepo: db.events,
        userRepo: db.users,
        contactRepo: db.contacts,
        invitationService: connectTelegramSceneDeps.invitationService,
        sendAsConnectedUser: connectTelegramSceneDeps.sendAsConnectedUser,
        deepLinkService: connectTelegramSceneDeps.deepLinkService,
        botUsername: connectTelegramSceneDeps.botUsername,
      }
    : undefined;
  const connectTelegramScene = createConnectTelegramScene(
    db.telegramSessions,
    config,
    userComposer,
    connectTelegramDeps,
  );
  const allScenes = [addEventScene, editValueScene, importScene, timezoneScene, onboardingScene, connectTelegramScene];

  return {
    plugin: scenes(allScenes, { storage: scopedStorage }),
    storage: scopedStorage,
    scenes: { addEventScene, editValueScene, importScene, timezoneScene, onboardingScene, connectTelegramScene },
  };
}

// src/bot/scenes/index.ts
import { scenes } from '@gramio/scenes';
import type { DatabaseService } from '../../database/index.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';
import { createAddEventScene } from './add-event.scene.ts';
import { wrapWithChatId } from './chat-scoped-storage.ts';
import { createEditValueScene } from './edit-value.scene.ts';
import { createImportScene } from './import.scene.ts';
import { createOnboardingScene } from './onboarding.scene.ts';
import { createSceneStorage } from './storage.ts';
import { createTimezoneScene } from './timezone.scene.ts';

export function createScenesPlugin(
  db: DatabaseService,
  eventService: EventService,
  botToken: string,
  userComposer: UserResolverComposer,
  gcalConfigured = false,
  prefsService?: NotificationPreferencesService,
  holidayService?: HolidayService,
  aiModel?: string,
  onEventCreated?: (userId: number, eventId: number) => Promise<void>,
) {
  const storage = createSceneStorage(db.db);
  // Cast satisfies GramIO's generic Storage<Data> structural contract:
  // wrapWithChatId returns a plain string-keyed interface that is a superset at runtime.
  const scopedStorage = wrapWithChatId(storage) as ReturnType<typeof createSceneStorage>;

  const addEventScene = createAddEventScene(eventService, userComposer, db.actionLog, onEventCreated);
  const editValueScene = createEditValueScene(eventService, userComposer, db.actionLog);
  const importScene = createImportScene(eventService, botToken, userComposer, db.actionLog);
  const timezoneScene = createTimezoneScene(db, userComposer, aiModel);
  const onboardingScene = createOnboardingScene(
    db,
    userComposer,
    gcalConfigured,
    prefsService,
    holidayService,
    aiModel,
  );
  const allScenes = [addEventScene, editValueScene, importScene, timezoneScene, onboardingScene];

  return {
    plugin: scenes(allScenes, { storage: scopedStorage }),
    storage: scopedStorage,
    scenes: { addEventScene, editValueScene, importScene, timezoneScene, onboardingScene },
  };
}

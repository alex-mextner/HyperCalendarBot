// src/bot/scenes/index.ts
import { scenes } from '@gramio/scenes';
import type { DatabaseService } from '../../database/index.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import { createAddEventScene } from './add-event.scene.ts';
import { createEditValueScene } from './edit-value.scene.ts';
import { createImportScene } from './import.scene.ts';
import { createOnboardingScene } from './onboarding.scene.ts';
import { createSceneStorage } from './storage.ts';
import { createTimezoneScene } from './timezone.scene.ts';

export function createScenesPlugin(
  db: DatabaseService,
  eventService: EventService,
  botToken: string,
  gcalConfigured = false,
  prefsService?: NotificationPreferencesService,
) {
  const storage = createSceneStorage(db.db);

  const addEventScene = createAddEventScene(eventService);
  const editValueScene = createEditValueScene(eventService);
  const importScene = createImportScene(eventService, botToken);
  const timezoneScene = createTimezoneScene(db);
  const onboardingScene = createOnboardingScene(db, gcalConfigured, prefsService);
  const allScenes = [addEventScene, editValueScene, importScene, timezoneScene, onboardingScene];

  return {
    plugin: scenes(allScenes, { storage }),
    storage,
    scenes: { addEventScene, editValueScene, importScene, timezoneScene, onboardingScene },
  };
}

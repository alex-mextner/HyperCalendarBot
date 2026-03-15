import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository';
import type { Visibility } from '../../database/types';

export class PrivacyService {
  constructor(private settingsRepo: SharingSettingsRepository) {}

  resolveVisibility(userId: number, eventId: number): Visibility {
    const eventOverride = this.settingsRepo.getEventVisibility(eventId);
    if (eventOverride) return eventOverride;

    const settings = this.settingsRepo.get(userId);
    return settings?.default_visibility ?? 'private';
  }

  canViewEvent(userId: number, eventId: number): boolean {
    return this.resolveVisibility(userId, eventId) !== 'private';
  }

  isFreeBusyOnly(userId: number, eventId: number): boolean {
    return this.resolveVisibility(userId, eventId) === 'free_busy';
  }
}

// src/config/constants/messages/en/gcal.ts
// Google Calendar connect, calendar picker and sync status messages.

export const enGcal = {
  gcal_onboarding:
    'Want to sync with Google Calendar?\n\nYour events will stay in the bot either way. Google Calendar sync is optional but gives you:\n- See bot events in your phone calendar\n- Changes in Google Calendar auto-sync to the bot\n- Two-way sync keeps everything up to date',
  gcal_onboarding_maybe_later: 'Maybe Later',
  gcal_not_configured: 'Google Calendar sync is not configured. Contact the admin.',
  gcal_already_connected: 'Google Calendar is already connected. Use /disconnect_google first to reconnect.',
  gcal_connect_prompt: '🔗 Connect Google Calendar to sync your events bidirectionally.',
  gcal_connect_button: 'Connect Google Calendar',
  gcal_connected: '✅ Google Calendar connected! Now pick which calendars to sync.',
  gcal_disconnected: '✅ Google Calendar disconnected. Your local events are untouched.',
  gcal_disconnect_confirm: 'Disconnect Google Calendar? Your events will stay in the bot.',
  gcal_disconnect_yes: 'Yes, disconnect',
  gcal_disconnect_no: 'Cancel',
  gcal_calendar_picker: 'Select calendars to sync (tap to toggle):',
  gcal_calendar_done: 'Done ✓',
  gcal_calendar_readonly: '(read-only)',
  gcal_calendars_saved: '✅ Calendar selection saved. Initial sync starting...',
  gcal_sync_complete: '✅ Initial sync complete. Your Google events are now in the bot.',
  gcal_revoked: '⚠️ Google Calendar connection lost. Use /connect_google to reconnect.',
  gcal_conflict: (title: string, winner: string) =>
    `⚠️ Sync conflict on "${title}"\n\n${winner === 'google' ? 'Google Calendar' : 'Local'} version was applied (more recent).`,
  gcal_status_connected: 'Connected ✅',
  gcal_status_not_connected: 'Google Calendar is not connected. Use /connect_google to start syncing.',
  gcal_status_sync_btn: '🔄 Sync now',
  gcal_status_calendars_btn: '⚙️ Calendars',
  gcal_status_sync_started: '⏳ Sync started',
} as const;

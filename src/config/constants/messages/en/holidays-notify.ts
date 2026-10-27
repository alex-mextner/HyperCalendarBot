// src/config/constants/messages/en/holidays-notify.ts
// Holiday subscriptions, AI error fallbacks and notification-settings labels.

export const enHolidaysNotify = {
  holidays_menu: '🌍 <b>Holiday Subscriptions</b>',
  holidays_no_subs: 'No countries added yet. Tap "+ Add" to subscribe.',
  holidays_added: (country: string) => `✅ Subscribed to ${country}`,
  holidays_removed: (country: string) => `Removed ${country}`,
  holidays_set_primary: (country: string) => `${country} set as primary`,
  holidays_pick_region: 'Choose a region:',
  holidays_pick_country: 'Choose a country:',
  holidays_upcoming: '📅 <b>Upcoming Holidays</b>',
  holidays_none_upcoming: 'No upcoming holidays for your subscriptions.',
  holidays_day_off: '🎉 Day off!',
  holidays_manage_prompt: 'Choose a subscription to manage:',
  holidays_notify_on: (country: string) => `${country}: notifications ON`,
  holidays_notify_off: (country: string) => `${country}: notifications OFF`,
  ai_error: 'AI is temporarily unavailable. Use bot commands (/help).',
  ai_send_error: '⚠️ An error occurred while sending the response. Please try again.',
  ai_clear_history: 'Chat history cleared.',
  scene_help_btn: '🆘 Ask AI for help',
  notify_menu: '⚙️ Notification Settings',
  notify_morning: '🌅 Morning Agenda',
  notify_morning_status: (enabled: boolean, time: string) => `Morning agenda: ${enabled ? `✅ ${time}` : '❌'}`,
  notify_evening: '🌙 Evening Review',
  notify_evening_status: (enabled: boolean, time: string) => `Evening review: ${enabled ? `✅ ${time}` : '❌'}`,
  notify_reminders: '⏰ Default Reminders',
  notify_quiet: '🔇 Quiet Hours',
  notify_quiet_status: (enabled: boolean, start: string, end: string) =>
    `Quiet hours: ${enabled ? `✅ ${start} — ${end}` : '❌'}`,
  notify_pick_hour: 'Pick hour:',
  notify_pick_minute: 'Pick minute:',
  notify_updated: 'Settings updated',
  notify_intervals_label: (intervals: number[]) =>
    `Default reminders: ${intervals.map((m) => (m === 0 ? 'at start' : m >= 60 ? `${m / 60}hr` : `${m}min`)).join(', ')}`,
} as const;

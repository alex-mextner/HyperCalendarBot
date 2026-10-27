// src/config/constants/messages/en/onboarding.ts
// Onboarding, timezone detection, country/agenda prompts and basic event result messages.

export const enOnboarding = {
  welcome: '🌍 Choose your language / Выберите язык:',
  tz_prompt: "Now let's set your timezone. The most accurate way is to share your location.",
  tz_detected: (tz: string, offset: string) => `Got it! Your timezone is ${tz} (${offset}).\nIs this correct?`,
  tz_confirm_yes: 'Yes ✓',
  tz_confirm_no: 'No, choose manually',
  geo_tz_confirm_prompt: (currentTz: string, newTz: string, offset: string) =>
    `📍 Your current timezone is <b>${currentTz}</b>.\nBased on your location, it looks like you're in <b>${newTz}</b> (${offset}).\n\nUpdating the timezone ensures reminders, agenda, and event times are shown correctly.\n\nUpdate timezone?`,
  geo_tz_confirm_btn: 'Yes, update ✓',
  geo_tz_dismiss_btn: 'No, keep current',
  event_map_btn: '🗺 Map',
  geo_tz_updated: (tz: string, offset: string) => `✅ Timezone updated to ${tz} (${offset}).`,
  geo_tz_dismissed: 'OK, timezone left unchanged.',
  tz_same_from_location: (tz: string, offset: string) =>
    `📍 Your timezone is already ${tz} (${offset}) — no changes needed.`,
  share_location: '📍 Share Location',
  choose_manually: '⌨️ Choose Manually',
  country_prompt: 'Want to see public holidays in your calendar?',
  country_skip: 'Skip',
  agenda_prompt: "I can send you a morning summary of your day's events.\n\nChoose a time for the daily agenda:",
  onboard_done:
    "✅ All set! Here's what you can do:\n\n/add — create an event\n/today — today's schedule\n\nJust send me a text or voice message — I understand natural language and can create, edit, search events for you.",
  no_events_today: (date: string) =>
    `📅 ${date}\n\nNo events today. Want to plan something? Just describe it in a message, or use /add.`,
  no_events: 'No events in this range.',
  event_created: (title: string) => `✅ Created: "${title}"`,
  event_deleted: (title: string) => `🗑 Deleted: "${title}"`,
  event_updated: (title: string) => `✏️ Updated: "${title}"`,
  confirm_delete: (title: string) => `Delete "${title}"?`,
  search_no_results: 'No events found.',
  something_wrong: 'Something went wrong. Try again or use /help.',
} as const;

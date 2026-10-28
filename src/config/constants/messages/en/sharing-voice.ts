// src/config/constants/messages/en/sharing-voice.ts
// Event sharing, voice-response prompts, group event notices and the feature tour.

export const enSharingVoice = {
  privacy_current: (level: string) => `🔒 Current visibility: <b>${level}</b>`,
  share_preview: '📤 Preview — this is what will be shared:',
  share_sent: '✅ Shared successfully',
  share_cancelled: '❌ Share cancelled',
  no_events_to_share: 'No events to share for this period',
  voice_response_enabled: '🎤 Voice responses enabled!',
  voice_response_disabled: '🎤 Ok, text only.',
  voice_demo_failed: '🎤 Voice enabled! Demo playback failed — voice replies will work from the next response.',
  cancelled: 'Cancelled.',
  voice_prompt: '🎤 Want voice replies?\nConvenient while driving, cooking, or on the go.',
  voice_prompt_yes: 'Yes, please',
  voice_prompt_no: 'No, text only',
  voice_stt_error: 'Could not recognize speech.',
  voice_error: 'Could not process voice message.',
  group_event_created: (groupRef: string, organizerLink: string) =>
    `📅 New event in ${groupRef}\n👤 Organizer: ${organizerLink}`,
  group_event_updated: (groupRef: string, organizerLink: string) =>
    `✏️ Event updated in ${groupRef}\n👤 Updated by: ${organizerLink}`,
  feature_tour_btn: '📖 All Features',
  feature_tour: [
    '<b>🤖 AI Assistant</b>\nJust text or voice-message me: "schedule a meeting tomorrow at 3pm", "what do I have next week?", "move my standup to 11:00". All bot features are available through chat — I understand context and execute commands.',
    '<b>📅 Calendar Management</b>\n/add — step-by-step event creation\n/today, /week, /month — different views\n/edit, /delete — modify events\n/free — find available time slots\nRecurring events with flexible rules.',
    '<b>🔔 Smart Reminders</b>\n/settings — morning agenda, evening review, quiet hours, voice calls, privacy\nMultiple reminders per event (15min, 1h, etc.)\nCustomizable notification intervals.',
    '<b>🌍 Holidays</b>\n/holidays — browse and subscribe to holidays from 100+ countries\nHolidays appear alongside your events in daily agenda.',
    '<b>📤 Sharing &amp; Invitations</b>\n/share today — share your agenda\n/invite @username — invite someone to an event\nEvent visibility: /settings → Privacy\nInline mode: type @HyperCalendarBot in any chat.',
    '<b>🖼 Visual Schedule</b>\nBeautiful calendar images are sent automatically with /today and /week commands.',
  ],
} as const;

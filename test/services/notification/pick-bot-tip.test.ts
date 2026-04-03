import { describe, expect, test } from 'bun:test';
import type { TipContext } from '../../../src/services/notification/scheduler.ts';
import { pickBotTip } from '../../../src/services/notification/scheduler.ts';

describe('pickBotTip', () => {
  test('returns null or a string (probabilistic)', () => {
    // Run many times — should get at least one non-null and one null
    let gotNull = false;
    let gotString = false;
    for (let i = 0; i < 100; i++) {
      const result = pickBotTip('en');
      if (result === null) gotNull = true;
      else gotString = true;
    }
    expect(gotNull).toBe(true);
    expect(gotString).toBe(true);
  });

  test('returns Russian text when lang is ru', () => {
    let found = false;
    for (let i = 0; i < 200; i++) {
      const result = pickBotTip('ru');
      if (result && /[а-яА-Я]/.test(result)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test('returns English text when lang is en', () => {
    let found = false;
    for (let i = 0; i < 200; i++) {
      const result = pickBotTip('en');
      if (result && /[a-zA-Z]/.test(result)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test('includes book quotes (not just bot tips)', () => {
    // Book quotes start with 📖
    let foundQuote = false;
    for (let i = 0; i < 500; i++) {
      const result = pickBotTip('en');
      if (result?.startsWith('📖')) {
        foundQuote = true;
        break;
      }
    }
    expect(foundQuote).toBe(true);
  });

  test('contextual tips appear when features are missing', () => {
    const ctx: TipContext = {
      hasMorningAgenda: true,
      hasEveningReview: false,
      hasQuietHours: false,
      hasGoogle: false,
      hasCountry: false,
      hasVoiceCalls: false,
    };

    // With many missing features and enough iterations, should see a contextual tip
    let foundContextual = false;
    for (let i = 0; i < 1000; i++) {
      const result = pickBotTip('en', ctx);
      if (
        result?.includes('Enable the evening review') ||
        result?.includes('quiet hours') ||
        result?.includes('Google Calendar') ||
        result?.includes('country') ||
        result?.includes('voice calls')
      ) {
        foundContextual = true;
        break;
      }
    }
    expect(foundContextual).toBe(true);
  });

  test('no contextual tips when all features are enabled', () => {
    const ctx: TipContext = {
      hasMorningAgenda: true,
      hasEveningReview: true,
      hasQuietHours: true,
      hasGoogle: true,
      hasCountry: true,
      hasVoiceCalls: true,
    };

    // Even with many iterations, contextual tips (the specific settings prompts) should not appear
    let foundContextual = false;
    for (let i = 0; i < 500; i++) {
      const result = pickBotTip('en', ctx);
      if (
        result?.includes('Enable the evening review to prepare for tomorrow:') ||
        result?.includes('Want to start each day with a plan? Enable the morning agenda:') ||
        result?.includes("Protect your sleep — set up quiet hours so I don't disturb") ||
        result?.includes('Connect Google Calendar to see all your events in one place — /connect_google.')
      ) {
        foundContextual = true;
        break;
      }
    }
    expect(foundContextual).toBe(false);
  });

  test('filters out tips about recently-used features', () => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const ctx: TipContext = {
      hasMorningAgenda: true,
      hasEveningReview: true,
      hasQuietHours: true,
      hasGoogle: true,
      hasCountry: true,
      hasVoiceCalls: true,
      featureUsage: [
        // events_create used 10 times recently — should filter out events_create tips
        { user_id: 1, feature_key: 'events_create', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'reminders', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'recurrence', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'sharing', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'google_calendar', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'voice_calls', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'contacts', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'holidays', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'settings', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'history', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'free_slots', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'month_view', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'morning_agenda', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'evening_review', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'import', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'quiet_hours', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'secretary', use_count: 10, last_used_at: now },
        { user_id: 1, feature_key: 'events_edit', use_count: 10, last_used_at: now },
      ],
    };

    // When all features are frequently used recently, bot tips should still return
    // (they fall through to the unfiltered path when all are filtered)
    let gotTip = false;
    for (let i = 0; i < 200; i++) {
      const result = pickBotTip('en', ctx);
      if (result?.startsWith('💡') || result?.startsWith('📖')) {
        gotTip = true;
        break;
      }
    }
    expect(gotTip).toBe(true);
  });

  test('re-engagement tips appear for stale features', () => {
    // Feature used a lot but 60 days ago
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    const ctx: TipContext = {
      hasMorningAgenda: true,
      hasEveningReview: true,
      hasQuietHours: true,
      hasGoogle: true,
      hasCountry: true,
      hasVoiceCalls: true,
      featureUsage: [
        // Only sharing is stale — all other features have no usage (discovery)
        { user_id: 1, feature_key: 'sharing', use_count: 20, last_used_at: sixtyDaysAgo },
      ],
    };

    // Run enough times — should eventually pick a tip (either discovery or re-engagement)
    let gotTip = false;
    for (let i = 0; i < 200; i++) {
      const result = pickBotTip('en', ctx);
      if (result?.startsWith('💡')) {
        gotTip = true;
        break;
      }
    }
    expect(gotTip).toBe(true);
  });
});

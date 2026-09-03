import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { EventOccurrence } from '../../../src/database/types.ts';
import { tagSender } from '../../../src/services/ai/agent.ts';
import { buildSystemPrompt } from '../../../src/services/ai/system-prompt.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('buildSystemPrompt', () => {
  let db: Database;
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const eventReminderRepo = new EventReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    const user = userRepo.create({
      telegram_id: USER_ID,
      username: 'testuser',
      first_name: 'Test',
      timezone: 'Europe/Kyiv',
      language: 'en',
    });
    const eventService = new EventService({ eventRepo });
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user,
      chatId: USER_ID,
      messageText: 'hello',
      isGroup: false,
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      eventReminderRepo,
      conversationLogger: null as never,
    };
  });

  // The prompt tells the model what a group message looks like; the agent is
  // what makes it look that way. They drifted apart once — the prompt described
  // a "[Group: …]" prefix nothing produced — and nothing noticed.
  test('describes the sender prefix the agent actually writes', () => {
    const prompt = buildSystemPrompt(ctx);
    const marker = tagSender('hello', 'Alex', 7).slice(0, '[From:'.length);
    expect(marker).toBe('[From:');
    expect(prompt).toContain(marker);
    expect(prompt).not.toContain('[Group:');
  });

  test('includes user timezone', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Europe/Kyiv');
  });

  test('includes user name', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Test');
  });

  test('includes user language', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('en');
  });

  test('includes formatting rules', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('ISO 8601');
  });

  test('instructs AI to always use tools for event data', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('ALWAYS use tools');
    expect(prompt).toContain('get_events');
  });

  /**
   * Tools travel to the model in the `tools` array with their own descriptions.
   * A prompt line that only says "for X, use tool Y" pays for that information a
   * second time in every request. These tools must therefore be reachable through
   * the catalog alone — the prompt keeps only guidance the schema cannot carry.
   */
  const TOOLS_DESCRIBED_ONLY_BY_THE_CATALOG = [
    'get_upcoming',
    'snooze_event',
    'get_reminders',
    'get_free_slots',
    'get_action_log',
    'get_history',
    'share_event',
    'share_agenda',
    'cancel_invitation',
  ];

  test('prompt does not restate what the tool catalog already describes', () => {
    const prompt = buildSystemPrompt(ctx);
    const restated = TOOLS_DESCRIBED_ONLY_BY_THE_CATALOG.filter((name) => prompt.includes(name));
    expect(restated).toEqual([]);
  });

  test('every tool the prompt stopped naming is still offered in the tool catalog', () => {
    const offered = getToolDefinitions('text')
      .filter((t) => t.type === 'function')
      .map((t) => t.function.name);
    for (const name of TOOLS_DESCRIBED_ONLY_BY_THE_CATALOG) {
      expect(offered).toContain(name);
    }
  });

  test('prompt does not name update_sharing_settings, which is not a tool', () => {
    const offered = getToolDefinitions('text')
      .filter((t) => t.type === 'function')
      .map((t) => t.function.name);
    expect(offered).not.toContain('update_sharing_settings');
    expect(buildSystemPrompt(ctx)).not.toContain('update_sharing_settings');
  });

  test('includes UTC offset for timezone conversion', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toMatch(/UTC\+\d/);
  });

  test('includes current local time for accurate time comparisons', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Current local time:');
    expect(prompt).toContain('authoritative clock');
  });

  test('DM prompt has two event creation modes: create or ask', () => {
    ctx.isGroup = false;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('EVENT CREATION — two modes in DMs');
    expect(prompt).toContain('Create immediately');
    expect(prompt).toContain('Ask first');
    // DM examples
    expect(prompt).toContain('Запиши встречу завтра в 10');
    expect(prompt).toContain('Запиши встречу с Леной');
    expect(prompt).toContain('Либо в 7, либо после 9');
    // No waiting in DMs
    expect(prompt).toContain('Never wait silently in DMs');
    // Group consensus block absent
    expect(prompt).not.toContain('Group event creation — consensus required');
  });

  test('group prompt requires clear intent AND consensus for event creation', () => {
    ctx.isGroup = true;
    ctx.groupTitle = 'Friends';
    ctx.groupChatId = -100;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('clear intent + consensus required');
    expect(prompt).toContain('Clear intent to create');
    expect(prompt).toContain('Consensus');
    expect(prompt).toContain('is NOT intent to create an event');
  });

  test('group consensus applies to event details (location, time), not only creation', () => {
    ctx.isGroup = true;
    ctx.groupTitle = 'Friends';
    ctx.groupChatId = -100;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('same consensus logic applies to');
    expect(prompt).toContain('event details');
    expect(prompt).toContain('У Иры');
  });

  test('group prompt has three creation modes with group-specific examples', () => {
    ctx.isGroup = true;
    ctx.groupTitle = 'Friends';
    ctx.groupChatId = -100;
    const prompt = buildSystemPrompt(ctx);
    // Proposal → [SKIP] → agreement → create
    expect(prompt).toContain('Давай в 7 на пейнтбол');
    expect(prompt).toContain('[SKIP], no consensus yet');
    expect(prompt).toContain('Давай!');
    expect(prompt).toContain('create');
    // Objection → [SKIP]
    expect(prompt).toContain('do NOT create, discussion continues');
    // No consensus → [SKIP]
    expect(prompt).toContain('Skip — no consensus yet');
    expect(prompt).toContain('output [SKIP] and do not reply');
    // Availability discussion → [SKIP]
    expect(prompt).toContain('listing her availability');
  });

  test('instructs how to invite people: @username direct, names via contacts, fallback to pick_users', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('pick_users');
    expect(prompt).toContain('get_contacts');
    expect(prompt).toContain('invitee_username');
    expect(prompt).toContain('send_invitation');
  });

  test('includes group context block when isGroup is true', () => {
    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Dev Team';
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('## Group Context');
    expect(prompt).toContain('Dev Team');
    expect(prompt).toContain('-100999');
    expect(prompt).toContain('[SKIP]');
    expect(prompt).toContain('group calendar');
  });

  test('does NOT include group context block in DM but includes [SKIP] for set_reaction', () => {
    ctx.isGroup = false;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('## Group Context');
    expect(prompt).toContain('[SKIP]');
  });

  test('includes language instruction for ru user', () => {
    const userRepo = new UserRepository(db);
    userRepo.update(USER_ID, { language: 'ru' });
    ctx.user = userRepo.findByTelegramId(USER_ID)!;

    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Russian');
  });

  test('includes shared events instructions', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Shared Events');
    expect(prompt).toContain('notify_participants');
    expect(prompt).toContain('propose_edit');
    expect(prompt).toContain('declines the invitation');
  });

  test('includes secretaryForLine in User Info when present', () => {
    ctx.secretary = {
      secretaryRepo: undefined as never,
      secretaryForLine: '@alice_cto (read+write)',
      calendarProposalRepo: undefined as never,
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Calendars you can manage as secretary: @alice_cto (read+write)');
  });

  test('omits secretary line when secretaryForLine absent', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('Calendars you can manage as secretary');
  });

  test('includes Secretary Access rules block when secretaryForLine present', () => {
    ctx.secretary = {
      secretaryRepo: undefined as never,
      secretaryForLine: '@bob_pm (read only)',
      calendarProposalRepo: undefined as never,
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('## Secretary Access');
  });

  test('group context includes Group Proposals rules when isGroup=true', () => {
    ctx.isGroup = true;
    ctx.groupTitle = 'Dev Team';
    ctx.groupChatId = -100;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('## Group Proposals');
    expect(prompt).toContain('propose_calendar_change');
  });

  test('group proposals rules absent in private chat', () => {
    ctx.isGroup = false;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('## Group Proposals');
  });

  test('group context includes privacy rules when isGroup=true', () => {
    ctx.isGroup = true;
    ctx.groupTitle = 'Dev Team';
    ctx.groupChatId = -100;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('## Group Privacy');
    expect(prompt).toContain('ask_user');
    expect(prompt).toContain('private');
  });

  test('privacy rules absent in private chat', () => {
    ctx.isGroup = false;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('## Group Privacy');
  });

  test('group context includes botUsername in help instruction when provided', () => {
    ctx.isGroup = true;
    ctx.groupTitle = 'Dev Team';
    ctx.groupChatId = -100;
    ctx.botUsername = 'mycalbot';
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('@mycalbot');
  });

  test('group context falls back to @mention when botUsername absent', () => {
    ctx.isGroup = true;
    ctx.groupTitle = 'Dev Team';
    ctx.groupChatId = -100;
    ctx.botUsername = undefined;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('@mention');
  });

  test('requires AI to use calculate tool for any arithmetic', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('CALCULATE RULE');
    expect(prompt).toContain('calculate');
    expect(prompt).toContain('Never compute in your head');
  });

  test('language instruction uses interface language framing, not user-speaks framing', () => {
    ctx.user = { ...ctx.user, language: 'ru' };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Bot interface language is Russian');
    expect(prompt).not.toContain('The user speaks Russian');
  });

  test('language instruction tells AI to respond in configured language regardless of input language', () => {
    ctx.user = { ...ctx.user, language: 'en' };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('even if the user writes in a different language');
  });

  test('language instruction tells AI to call manage_settings for language change requests', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('manage_settings');
    expect(prompt).toContain('"ru"');
    expect(prompt).toContain('"en"');
  });

  test('system prompt includes default duration when set', () => {
    ctx.user = { ...ctx.user, default_event_duration_minutes: 45 };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Default event duration: 45 minutes');
  });

  test('system prompt includes 60 min default', () => {
    ctx.user = { ...ctx.user, default_event_duration_minutes: 60 };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Default event duration: 60 minutes');
  });

  test('forbids markdown tables', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Never use markdown tables');
  });

  describe('supplement mode section', () => {
    test('supplement section absent when supplementMode is not set', () => {
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).not.toContain('Supplement Mode');
    });

    test('supplement section absent when supplementMode is false', () => {
      ctx.supplementMode = false;
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).not.toContain('Supplement Mode');
    });

    test('supplement section present when supplementMode is true', () => {
      ctx.supplementMode = true;
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).toContain('Supplement Mode');
      expect(prompt).toContain('supplement_skip');
      expect(prompt).toContain('rule-based intent system');
    });
  });

  test('does not include scene section when scenePauseState is absent', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('## Scene Paused');
  });

  test('includes scene section when scenePauseState is set', () => {
    ctx.scene = {
      scenePauseState: { sceneName: 'add_event', step: 1, sceneState: { title: 'Team meeting' } },
      scenePauseService: undefined as never,
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('## Scene Paused');
    expect(prompt).toContain('add_event');
    expect(prompt).toContain('step 1');
    expect(prompt).toContain('Team meeting');
  });

  test('scene section mentions resume_scene and cancel_scene tools', () => {
    ctx.scene = {
      scenePauseState: { sceneName: 'edit_value', step: 0, sceneState: {} },
      scenePauseService: undefined as never,
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('resume_scene');
    expect(prompt).toContain('cancel_scene');
  });

  test('scene section shows "(none yet)" when sceneState is empty', () => {
    ctx.scene = {
      scenePauseState: { sceneName: 'add_event', step: 0, sceneState: {} },
      scenePauseService: undefined as never,
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('(none yet)');
  });

  describe('schedule context window', () => {
    /** One stored event replayed at N distinct times — the shape a recurring event produces. */
    function occurrences(count: number): EventOccurrence[] {
      const eventRepo = new EventRepository(db);
      const event = eventRepo.create({
        user_id: USER_ID,
        title: 'Standup',
        start_at: '2026-03-16T08:00:00Z',
        timezone: 'Europe/Kyiv',
      });
      return Array.from({ length: count }, (_, i) => {
        const start = new Date(Date.UTC(2026, 2, 16, 8, 0, 0) + i * 3_600_000);
        return {
          event,
          occurrence_start: start.toISOString(),
          occurrence_end: null,
          is_exception: false,
        };
      });
    }

    function listedOccurrences(prompt: string): number {
      const section = prompt.split('## Schedule Context')[1]?.split('\n## ')[0] ?? '';
      return (section.match(/Standup/g) ?? []).length;
    }

    test('lists every occurrence when the window is small', () => {
      ctx.recentEventsWindow = occurrences(12);
      const prompt = buildSystemPrompt(ctx);
      expect(listedOccurrences(prompt)).toBe(12);
      expect(prompt).not.toContain('more occurrences not listed');
    });

    test('caps a heavy window and says how many were left out', () => {
      ctx.recentEventsWindow = occurrences(200);
      const prompt = buildSystemPrompt(ctx);
      expect(listedOccurrences(prompt)).toBe(60);
      expect(prompt).toContain(
        '(+140 more occurrences in this window, earlier and later — call get_events for the full list)',
      );
    });

    /**
     * Occurrences spread evenly across the real ±2-week window, oldest first —
     * the order and shape getEventsInRange actually returns. Past and future
     * carry different titles so the assertions can tell which half survived.
     */
    function spanningOccurrences(perSide: number): { window: EventOccurrence[] } {
      const eventRepo = new EventRepository(db);
      const past = eventRepo.create({
        user_id: USER_ID,
        title: 'Already happened',
        start_at: new Date().toISOString(),
        timezone: 'Europe/Kyiv',
      });
      const future = eventRepo.create({
        user_id: USER_ID,
        title: 'Still ahead',
        start_at: new Date().toISOString(),
        timezone: 'Europe/Kyiv',
      });
      const hour = 3_600_000;
      const make = (event: typeof past, offset: number): EventOccurrence => ({
        event,
        occurrence_start: new Date(Date.now() + offset).toISOString(),
        occurrence_end: null,
        is_exception: false,
      });
      return {
        window: [
          ...Array.from({ length: perSide }, (_, i) => make(past, -(perSide - i) * hour)),
          ...Array.from({ length: perSide }, (_, i) => make(future, (i + 1) * hour)),
        ],
      };
    }

    function scheduleSection(prompt: string): string {
      return prompt.split('## Schedule Context')[1]?.split('\n## ')[0] ?? '';
    }

    // The window runs from two weeks ago to two weeks ahead and arrives sorted
    // oldest-first, so taking the first sixty kept only the past: a heavy user
    // got a "schedule context" with nothing from today onwards, which is the
    // opposite of what the section is for.
    test('keeps the occurrences nearest to now, not the oldest ones', () => {
      ctx.recentEventsWindow = spanningOccurrences(100).window;
      const section = scheduleSection(buildSystemPrompt(ctx));

      const ahead = (section.match(/Still ahead/g) ?? []).length;
      const behind = (section.match(/Already happened/g) ?? []).length;
      expect(ahead + behind).toBe(60);
      expect(ahead).toBe(30);
      expect(behind).toBe(30);
      expect(section).toContain('← today');
    });

    test('the cap keeps a heavy window from dominating the prompt', () => {
      ctx.recentEventsWindow = occurrences(12);
      const small = buildSystemPrompt(ctx).length;
      ctx.recentEventsWindow = occurrences(500);
      const huge = buildSystemPrompt(ctx).length;
      expect(huge - small).toBeLessThan(1500);
    });

    test('says so explicitly when the window is empty', () => {
      ctx.recentEventsWindow = [];
      expect(buildSystemPrompt(ctx)).toContain('(no events in this window)');
    });
  });

  test('instructs AI that user times are local and must be converted to UTC', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('CRITICAL');
    expect(prompt).toContain('local timezone');
    expect(prompt).toContain('NEVER append "Z" to a local time');
    expect(prompt).toContain('calculate');
  });

  test('does not tell AI to pass LITERAL times to tools', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('pass the LITERAL date/time');
  });

  // Everything the prompt inlines from a user's own data is re-sent on every
  // round of every message, so each such section needs a ceiling. The schedule
  // window has one; these two are the same risk by another route.
  describe("sections built from the user's own data", () => {
    /**
     * The prompt reads exactly two things off this capability, and the repo
     * permits the partial-mock cast inside a factory like this one.
     */
    function withMemory(facts: string[]): AgentContext {
      const birthday = {
        userMemoryRepo: { getAll: () => facts.map((content) => ({ content })) },
      } as unknown as AgentContext['birthday'];
      return { ...ctx, birthday };
    }

    test('caps the remembered facts by size and says how many are held back', () => {
      const long = 'x'.repeat(200);
      const prompt = buildSystemPrompt(withMemory(Array.from({ length: 40 }, (_, i) => `${i} ${long}`)));
      const listed = prompt.split('\n').filter((line) => line.includes(long)).length;
      expect(listed).toBeLessThan(40);
      expect(prompt).toContain('facts kept but not shown here');
    });

    // The newest facts are the ones likeliest to still be true.
    test('keeps the newest facts when it has to choose', () => {
      const long = 'y'.repeat(300);
      const prompt = buildSystemPrompt(withMemory([`oldest ${long}`, `middle ${long}`, `newest ${long}`]));
      expect(prompt).toContain(`newest ${long}`);
    });

    // One enormous fact used to end the loop on its first turn and take every
    // small one with it, leaving a section that showed nothing.
    test('one oversized fact does not take the rest with it', () => {
      const facts = ['likes tea', 'lives in Belgrade', 'z'.repeat(3_000)];
      const prompt = buildSystemPrompt(withMemory(facts));
      expect(prompt).toContain('- likes tea');
      expect(prompt).toContain('- lives in Belgrade');
      expect(prompt).toContain('+1 facts kept but not shown here');
    });

    test('a short memory is untouched', () => {
      const prompt = buildSystemPrompt(withMemory(['likes tea', 'lives in Belgrade']));
      expect(prompt).toContain('- likes tea');
      expect(prompt).not.toContain('facts kept but not shown here');
    });

    // Cut on a line boundary, so the last entry is a whole place rather than a
    // fragment the model could read as an address.
    test('caps the known places on a line boundary', () => {
      const place = (i: number) => `Place ${i} — ${'street '.repeat(20)}`;
      const context = Array.from({ length: 40 }, (_, i) => place(i)).join('\n');
      const prompt = buildSystemPrompt({ ...ctx, preloadedAddressContext: context });
      expect(prompt).toContain('more places not listed');
      const shown = prompt.split('## Known Locations\n')[1]?.split('\n(more places')[0] ?? '';
      // Whole entries only: the last line shown is one of the ones fed in.
      expect(shown.split('\n').every((line) => context.split('\n').includes(line))).toBe(true);
    });

    // A single entry longer than the whole budget has no line break to cut on,
    // and the -1 that answers for one would have kept the entire string.
    test('caps a single oversized entry that has no line break', () => {
      const oneLine = `Place — ${'street '.repeat(1_000)}`;
      const prompt = buildSystemPrompt({ ...ctx, preloadedAddressContext: oneLine });
      expect(prompt).toContain('more places not listed');
      const shown = prompt.split('## Known Locations\n')[1]?.split('\n(more places')[0] ?? '';
      expect(shown.length).toBeLessThanOrEqual(2_000);
    });

    test('a short list of places is untouched', () => {
      const prompt = buildSystemPrompt({ ...ctx, preloadedAddressContext: 'Home — Knez Mihailova 1' });
      expect(prompt).toContain('Home — Knez Mihailova 1');
      expect(prompt).not.toContain('more places not listed');
    });
  });
});

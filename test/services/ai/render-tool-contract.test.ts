// Contract fixtures for the picture tools (AGENTS.md "Prompt/tool contracts"): the concrete calls the
// prompt and the tool schemas teach the model are executed through the real tool exposure (lazy and
// hybrid), the real schema validation and the real handlers, at UTC and IANA zones and on DST dates.
// A queued picture must carry the right local day / week / month, and the model must be told it is
// only queued.
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { TZDate } from '@date-fns/tz';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { _resetToolThrottleForTest, executeTool } from '../../../src/services/ai/tool-executor.ts';
import { createToolExposure } from '../../../src/services/ai/tool-exposure.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import type { ImageRenderJob } from '../../../src/worker/image-render.queue.ts';
import { getTemplate } from '../../../src/worker/templates/index.ts';
import { makeImageDelivery } from '../../fixtures/image-delivery.ts';
import { png } from '../../fixtures/png.ts';

const USER_ID = 7120;

/** Zones with a DST date each: the shift happens on that local day, so the day has 23 or 25 hours. */
const ZONES: [timezone: string, date: string][] = [
  ['UTC', '2026-03-29'],
  ['Europe/Belgrade', '2026-03-29'], // spring forward
  ['Europe/Belgrade', '2026-10-25'], // fall back
  ['Pacific/Auckland', '2026-09-27'], // spring forward, UTC+12 -> +13
  ['Pacific/Auckland', '2027-04-04'], // fall back
  ['America/Los_Angeles', '2026-03-08'],
  ['America/Los_Angeles', '2026-11-01'],
];

/** Monday of the ISO week of a calendar date, by plain UTC arithmetic: independent of the handler's code. */
function mondayOf(date: string): string {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

function setup(timezone: string) {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  userRepo.create({ telegram_id: USER_ID, timezone, language: 'en' });
  const chatHistory = new ChatHistoryRepository(db);
  const jobs: ImageRenderJob[] = [];
  const photos: number[] = [];
  const eventService = new EventService({ eventRepo: new EventRepository(db) });
  const { delivery } = makeImageDelivery(async (job) => {
    jobs.push(job);
    return png();
  });
  const ctx = {
    user: userRepo.findByTelegramId(USER_ID)!,
    chatId: USER_ID,
    messageText: '',
    isGroup: false,
    eventService,
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory,
    conversationLogger: new ConversationLogger(chatHistory),
    userRepo,
    eventReminderRepo: new EventReminderRepository(db),
    sender: {
      sendMessage: async () => ({ message_id: 1 }),
      sendPhoto: async () => {
        photos.push(1);
        return { message_id: 2 };
      },
    },
    imageDelivery: delivery,
  } as unknown as AgentContext;
  return { ctx, jobs, photos, eventService, delivery, db };
}

/** What the model does in each tool schema mode: a tool that is not loaded is discovered one round earlier. */
function callThroughExposure(mode: 'lazy' | 'hybrid', name: string, input: { [key: string]: unknown }) {
  const exposure = createToolExposure(getToolDefinitions('text'), mode);
  let exposed = exposure.snapshot();
  const discovered = !exposed.has(name);
  if (discovered) {
    const discovery = exposure.intercept('discover_tools', { tools: [name] }, exposed);
    expect(discovery?.success).toBe(true);
    exposed = exposure.snapshot();
  }
  expect(exposed.has(name)).toBe(true);
  // With the schema loaded, the call is no longer intercepted.
  expect(exposure.intercept(name, input, exposed)).toBeUndefined();
  return { discovered };
}

beforeEach(() => {
  _resetToolThrottleForTest();
});

describe.each(['lazy', 'hybrid'] as const)('picture tool calls the prompt teaches (%s mode)', (mode) => {
  test.each(
    ZONES,
  )('render_day_image at %s on %s queues the local day and the model learns it is queued', async (timezone, date) => {
    const { ctx, jobs, photos, eventService, delivery, db } = setup(timezone);
    // An event late in the DST day: it must sit on that local day, whatever the UTC offset did.
    eventService.createEvent({
      user_id: USER_ID,
      title: 'Synthetic late lesson',
      start_at: new Date(
        new TZDate(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8)), 23, 30, timezone),
      ).toISOString(),
      timezone,
    });
    const input = { date };
    callThroughExposure(mode, 'render_day_image', input);

    const result = await executeTool(ctx, 'render_day_image', input);
    expect(result.success).toBe(true);
    expect(photos).toHaveLength(0);
    expect(result.agentHint).toContain('NOT sent yet');
    await delivery.whenIdle();

    const job = jobs[0];
    if (job?.type !== 'daily-agenda') throw new Error(`expected a daily-agenda job, got ${job?.type}`);
    expect(job.data.date).toBe(date);
    expect(JSON.stringify(job.data)).toContain('Synthetic late lesson');
    expect(photos).toHaveLength(1);
    db.close();
  });

  test.each(
    ZONES,
  )('render_week_image at %s on %s queues the Monday-based week of that date', async (timezone, date) => {
    const { ctx, jobs, delivery, db } = setup(timezone);
    const input = { week_start: date };
    callThroughExposure(mode, 'render_week_image', input);

    const result = await executeTool(ctx, 'render_week_image', input);
    expect(result.success).toBe(true);
    await delivery.whenIdle();

    const job = jobs[0];
    if (job?.type !== 'weekly-overview') throw new Error(`expected a weekly-overview job, got ${job?.type}`);
    expect(job.data.days).toHaveLength(7);
    expect(job.data.days[0]?.dayNumber).toBe(Number(mondayOf(date).slice(8)));
    db.close();
  });

  test.each(ZONES)('render_month_image at %s for the month of %s queues that month', async (timezone, date) => {
    const { ctx, jobs, delivery, db } = setup(timezone);
    const input = { month: date.slice(0, 7) };
    callThroughExposure(mode, 'render_month_image', input);

    const result = await executeTool(ctx, 'render_month_image', input);
    expect(result.success).toBe(true);
    await delivery.whenIdle();

    const job = jobs[0];
    if (job?.type !== 'monthly-calendar') throw new Error(`expected a monthly-calendar job, got ${job?.type}`);
    expect(job.data.monthLabel).toContain(date.slice(0, 4));
    db.close();
  });

  test('render_table: the markdown example in its own schema runs through the handler and the real template', async () => {
    const definition = getToolDefinitions('text').find(
      (tool) => tool.type === 'function' && tool.function.name === 'render_table',
    );
    if (definition?.type !== 'function') throw new Error('render_table is not offered in text mode');
    const markdownSchema = (definition.function.parameters as { properties: { markdown: { description: string } } })
      .properties.markdown;
    // The schema quotes the table the model should send: "| Plan | Price |\n|---|---|\n| Basic | $5 |".
    const quoted = /e\.g\. "(.+)"/.exec(markdownSchema.description)?.[1];
    if (!quoted) throw new Error('the render_table schema no longer quotes a markdown example');
    const markdown = quoted.replaceAll('\\n', '\n');

    const { ctx, jobs, photos, delivery, db } = setup('Europe/Belgrade');
    const input = { title: 'Plans', markdown };
    callThroughExposure(mode, 'render_table', input);
    const result = await executeTool(ctx, 'render_table', input);

    expect(result.success).toBe(true);
    expect(photos).toHaveLength(0);
    await delivery.whenIdle();
    const job = jobs[0];
    if (job?.type !== 'md-table') throw new Error(`expected an md-table job, got ${job?.type}`);
    // The worker side parses the same example: it renders to HTML with its rows.
    const html = getTemplate('md-table').render(job.data);
    expect(html).toContain('Basic');
    expect(html).toContain('$5');
    db.close();
  });
});

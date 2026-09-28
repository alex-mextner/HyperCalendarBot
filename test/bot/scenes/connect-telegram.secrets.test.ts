/**
 * The connect-telegram wizard collects a phone number, a login code and a 2FA password.
 * Drives the real GramIO chain in production order (connect-wizard guard → rate limiter → chat
 * logging → command escape → scenes) against a real in-memory database, then checks every place
 * the bot keeps or forwards conversation text: chat_history, action_log, the next AI turn and its
 * debug log.
 * All credentials here are synthetic.
 */
import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scenes } from '@gramio/scenes';
import { Bot } from 'gramio';
import { z } from 'zod';
import { handleSettingsCallback } from '../../../src/bot/commands/settings.ts';
import { createCallbackFallback } from '../../../src/bot/middleware/callback-fallback.ts';
import { createChatLogging } from '../../../src/bot/middleware/chat-logging.ts';
import { createConnectWizardGuard } from '../../../src/bot/middleware/connect-wizard-guard.ts';
import { createRateLimitMiddleware, RateLimiter } from '../../../src/bot/middleware/rate-limiter.ts';
import { createSceneCommandEscape } from '../../../src/bot/middleware/scene-command-escape.ts';
import { createUserResolver, createUserResolverComposer } from '../../../src/bot/middleware/user-resolver.ts';
import { runWithChatId } from '../../../src/bot/scenes/chat-scoped-storage.ts';
import {
  CONNECT_WIZARD_REDACTION,
  createConnectTelegramScene,
} from '../../../src/bot/scenes/connect-telegram.scene.ts';
import { createConnectWizardTraces } from '../../../src/bot/scenes/connect-wizard-trace.ts';
import { createScopedSceneStorage } from '../../../src/bot/scenes/index.ts';
import { maskPhone, RATE_LIMIT, t } from '../../../src/config/constants.ts';
import { DatabaseService } from '../../../src/database/index.ts';
import type { User } from '../../../src/database/types.ts';
import { type AgentRunResult, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { AiDebugLogger } from '../../../src/services/ai/debug-logger.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { createCommandUsageTracking } from '../../../src/services/feature-tracking.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { NotificationPreferencesService } from '../../../src/services/notification/preferences.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';
import { jsonCodec } from '../../../src/utils/json-codec.ts';
import { captureLogs } from '../../helpers/log-capture.ts';

const TYPED_PHONE = '+1 555 010 4471';
const PHONE = '+15550104471';
const TYPED_CODE = '97 531';
const CODE = '97531';
const PASSWORD = 'Synth-2FA pass phrase';
const SECRETS = [TYPED_PHONE, PHONE, TYPED_CODE, CODE, PASSWORD];
/** The approved labels of the buttons under a held message (the synthetic user speaks Russian). */
const PROCESS_LABEL = 'Это обычный запрос — обработать';
const DISCARD_LABEL = 'Удалить';
/** The notice for a held message the bot no longer has asks the user to send it again. */
function isResendNotice(text: string): boolean {
  return text.includes('отправь его ещё раз');
}

const ButtonSchema = z.object({ text: z.string(), callback_data: z.string().optional() });
const RequestSchema = z.object({
  text: z.string().optional(),
  message_id: z.number().optional(),
  reply_markup: z.object({ inline_keyboard: z.array(z.array(ButtonSchema)).optional() }).optional(),
});
/** What an audit row may say about a protected input: never its text, length or a digest of it. */
const AuditMetadataSchema = z
  .object({ step: z.string().optional(), deletion: z.string().optional(), outcome: z.string().optional() })
  .strict();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  setSystemTime();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

let nextUserId = 719_000;

function leakedSecrets(haystack: string): string[] {
  return SECRETS.filter((secret) => haystack.includes(secret));
}

/** Moves the clock forward, as the scene store's TTL and the rate limiter see it. */
function advanceClock(ms: number) {
  setSystemTime(new Date(Date.now() + ms));
}

/**
 * `sendCodeFailure`: the MTProto bridge fails to send the login code with this message (it may name the
 * phone number, as a provider error can).
 */
function makeRuntime(options: { messagesPerMinute?: number; sendCodeFailure?: string } = {}) {
  const db = new DatabaseService(':memory:');
  const userId = nextUserId++;
  const chat = { id: userId, type: 'private' as const };
  db.users.create({ telegram_id: userId, language: 'ru', timezone: 'Europe/Belgrade' });
  const conversationLogger = new ConversationLogger(db.chatHistory);
  const tmp = mkdtempSync(path.join(tmpdir(), 'connect-secrets-'));
  const debugDir = path.join(tmp, 'debug');
  // Every log line any module writes during the test.
  const logs = captureLogs();

  /** Every message the bot sent or edited, with its inline buttons. */
  const sent: { id: number; method: string; text: string; buttons: { text: string; data: string }[] }[] = [];
  /** Texts of callback-query answers (toasts). */
  const toasts: string[] = [];
  const deletedMessageIds: number[] = [];
  // deleteMessage calls answered only once the test releases them, by message id.
  const heldDeletions = new Map<number, Promise<void>>();
  let refuseDeletions = false;
  let outgoing = 1000;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const payload = jsonCodec(RequestSchema).parse(await request.text());
      const method = new URL(request.url).pathname.split('/').at(-1);
      if (method === 'answerCallbackQuery') {
        if (payload.text !== undefined) toasts.push(payload.text);
        return Response.json({ ok: true, result: true });
      }
      if (method === 'deleteMessage') {
        if (refuseDeletions) {
          return Response.json({ ok: false, error_code: 400, description: "Bad Request: message can't be deleted" });
        }
        if (payload.message_id !== undefined) {
          deletedMessageIds.push(payload.message_id);
          await heldDeletions.get(payload.message_id);
        }
        return Response.json({ ok: true, result: true });
      }
      const id = method === 'editMessageText' && payload.message_id !== undefined ? payload.message_id : outgoing++;
      const buttons = (payload.reply_markup?.inline_keyboard ?? [])
        .flat()
        .flatMap((button) =>
          button.callback_data === undefined ? [] : [{ text: button.text, data: button.callback_data }],
        );
      sent.push({ id, method: method ?? '', text: payload.text ?? '', buttons });
      return Response.json({
        ok: true,
        result: { message_id: id, date: 1, chat, from: { id: 1, is_bot: true, first_name: 'Bot' }, text: payload.text },
      });
    },
  });

  // Synthetic MTProto side: the code needs a password, the password signs in.
  const sessionPath = path.join(tmp, 'session.session');
  writeFileSync(sessionPath, 'synthetic-session-bytes');
  // Real removeLiveAuthHandle, observed: it is what stops the MTProto login process.
  const endAuth = spyOn(SessionBridge, 'removeLiveAuthHandle');
  const spies = [
    endAuth,
    spyOn(SessionBridge, 'reserveEmptySessionPath').mockReturnValue(sessionPath),
    spyOn(SessionBridge, 'spawnSendAndSign').mockResolvedValue(
      options.sendCodeFailure === undefined
        ? { success: true, data: { phone_code_hash: 'synthetic-hash' } }
        : { success: false, error: 'UNEXPECTED', message: options.sendCodeFailure },
    ),
    spyOn(SessionBridge, 'getLiveAuthHandle').mockReturnValue({
      phoneCodeHash: 'synthetic-hash',
      submitCode: () => Promise.resolve({ success: true, data: { status: '2fa_required' } }),
      submitPassword: () => Promise.resolve({ success: true, data: { status: 'ok' } }),
      kill: () => undefined,
    }),
  ];

  const eventService = new EventService({ eventRepo: db.events });
  const holidayService = new HolidayService(db.holidays);
  const buildContext = (user: User, chatId: number, messageText: string): AgentContext => ({
    user,
    chatId,
    messageText,
    isGroup: false,
    eventService,
    holidayService,
    chatHistory: db.chatHistory,
    conversationLogger,
    userRepo: db.users,
    eventReminderRepo: db.eventReminders,
  });

  // The first AI turn: the same history read, message build and debug log as CalendarBotAgent.run.
  const aiTurns: string[] = [];
  const agent = new CalendarBotAgent(
    {},
    {
      sendMessage: () => Promise.resolve({ message_id: 1 }),
      editMessageText: () => Promise.resolve(),
    },
  );
  const debugLogger = new AiDebugLogger(true, debugDir);
  const runAgent = async (ctx: AgentContext): Promise<AgentRunResult> => {
    const history = ctx.chatHistory.getRecent(ctx.user.telegram_id, 30);
    const { messages } = await agent.buildMessages(ctx, history);
    const run = debugLogger.createRunContext(userId, ctx.chatId, null, 'Synthetic', null, false, ctx.messageText);
    run?.logHistory(messages);
    run?.flush();
    aiTurns.push(JSON.stringify(messages));
    return { responseText: '', toolCalls: [], toolResults: [] };
  };

  // Texts that got past the scene and the command escape to the bot's own message handlers.
  const reachedHandlers: string[] = [];
  /** Commands that reached their command handler. */
  const commandsRun: string[] = [];
  const errors: Error[] = [];
  /** When set, the guard's reads of the scene store fail, as an unreadable SQLite store would. */
  let sceneReadsFail = false;

  /** The bot as src/bot/index.ts wires it. Called again to model a restart: no in-memory state survives. */
  function startBot() {
    const storage = createScopedSceneStorage(db);
    const guard = createConnectWizardGuard({
      sceneStorage: {
        get(key: string) {
          if (sceneReadsFail) throw new Error('synthetic scene store failure');
          return storage.get(key);
        },
        delete: (key: string) => storage.delete(key),
      },
      traces: createConnectWizardTraces(db.db),
      conversationLogger,
      actionLog: db.actionLog,
      replay: (update) => started.updates.handleUpdate(update),
    });
    const scene = createConnectTelegramScene(
      db.telegramSessions,
      { TELEGRAM_SESSION_MASTER_KEY: '0'.repeat(64) },
      createUserResolverComposer(db),
      {
        eventRepo: db.events,
        userRepo: db.users,
        contactRepo: db.contacts,
        invitationService: new InvitationService(db.invitations, db.events, db.sharingSettings),
      },
    );
    const rateLimiter = new RateLimiter({
      perMinute: options.messagesPerMinute ?? RATE_LIMIT.MESSAGES_PER_MINUTE,
      cooldownMs: RATE_LIMIT.COOLDOWN_MS,
    });
    const started = new Bot('1:synthetic-test', {
      info: { id: 1, is_bot: true, first_name: 'Bot', username: 'SyntheticTestBot' },
      api: { baseURL: `http://127.0.0.1:${server.port}/bot` },
    })
      .derive(createUserResolver(db))
      // Same chat scoping as src/bot/index.ts, which does not scope edited messages either.
      .use((context, next) =>
        runWithChatId(
          context.update?.message?.chat?.id ?? context.update?.callback_query?.message?.chat?.id ?? 0,
          next,
        ),
      )
      .use(guard.middleware)
      .use(createRateLimitMiddleware(rateLimiter, guard.recordRateLimited))
      .use(
        createChatLogging({
          conversationLogger,
          actionLog: db.actionLog,
          chatHistoryIds: new Map<number, number>(),
          isConnectWizardInput: guard.isConnectWizardInput,
        }),
      )
      .use(guard.callbacks)
      .use(createSceneCommandEscape(storage))
      .use(createCallbackFallback(storage))
      .extend(scenes([scene], { storage }))
      .use(guard.stopUnhandledInput)
      .on('message', createCommandUsageTracking(db.featureUsage))
      .command('connect_telegram', (ctx) => ctx.scene.enter(scene))
      .command('today', () => {
        commandsRun.push('today');
      })
      .on('callback_query', async (ctx) => {
        const data = ctx.data ?? '';
        if (!ctx.dbUser || !data.startsWith('stg:')) return;
        await handleSettingsCallback(
          ctx,
          ctx.dbUser,
          data.slice('stg:'.length),
          new NotificationPreferencesService(db.notificationPreferences),
          undefined,
          undefined,
          db.users,
          { sessionRepo: db.telegramSessions, masterKey: null, enterScene: () => ctx.scene.enter(scene) },
        );
      })
      .on('message', async (ctx) => {
        if (ctx.text) reachedHandlers.push(ctx.text);
        // Like the message handler: slash text never starts an AI turn.
        if (!ctx.dbUser || !ctx.text || ctx.text.startsWith('/')) return;
        await runAgent(buildContext(ctx.dbUser, userId, ctx.text));
      });
    started.onError((ctx) => {
      errors.push(ctx.error);
    });
    return started;
  }
  let bot = startBot();

  cleanups.push(async () => {
    for (const spy of spies) spy.mockRestore();
    logs.restore();
    // @gramio/storage-sqlite sweeps expired rows on a zero-delay timer it does not expose, and a restart
    // schedules another. A real timer queued after it is the only way to let it run before the close.
    const swept = Promise.withResolvers<void>();
    setTimeout(swept.resolve);
    await swept.promise;
    server.stop(true);
    db.db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  let incoming = 1;
  const from = { id: userId, is_bot: false, first_name: 'Synthetic' };
  /**
   * A text the user sends now. `deliver()` hands it to the bot — possibly after updates sent later,
   * as concurrent webhook deliveries can arrive.
   */
  function typed(text: string) {
    const id = incoming++;
    return {
      id,
      async deliver() {
        await bot.updates.handleUpdate({
          update_id: id,
          message: {
            message_id: id,
            date: 1,
            chat,
            from,
            text,
            ...(text.startsWith('/')
              ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] }
              : {}),
          },
        });
        expect(errors).toEqual([]);
      },
    };
  }
  async function send(text: string): Promise<number> {
    const message = typed(text);
    await message.deliver();
    return message.id;
  }
  async function edit(messageId: number, text: string) {
    await bot.updates.handleUpdate({
      update_id: incoming++,
      edited_message: { message_id: messageId, date: 1, edit_date: 2, chat, from, text },
    });
    expect(errors).toEqual([]);
  }
  async function click(data: string) {
    await pressButton(data, sent.at(-1)!.id);
  }
  /**
   * A button press on message `messageId`, by the user in their chat unless another sender or chat is
   * named. Like Telegram, the pressed message comes with its inline keyboard.
   */
  async function pressButton(data: string, messageId: number, as: { userId?: number; chatId?: number } = {}) {
    const presser = as.userId === undefined ? from : { id: as.userId, is_bot: false, first_name: 'Other' };
    const inChat = as.chatId === undefined ? chat : { id: as.chatId, type: 'private' as const };
    const buttons = sent.findLast((entry) => entry.id === messageId && entry.buttons.length > 0)?.buttons ?? [];
    await bot.updates.handleUpdate({
      update_id: incoming++,
      callback_query: {
        id: String(incoming),
        chat_instance: 'synthetic',
        data,
        from: presser,
        message: {
          message_id: messageId,
          date: 1,
          chat: inChat,
          ...(buttons.length > 0
            ? {
                reply_markup: {
                  inline_keyboard: [buttons.map((button) => ({ text: button.text, callback_data: button.data }))],
                },
              }
            : {}),
        },
      },
    });
    expect(errors).toEqual([]);
  }
  /** Presses the button labelled `label` on the latest bot message that carried it. */
  async function clickButton(label: string, as: { userId?: number; chatId?: number } = {}) {
    const message = sent.findLast((entry) => entry.buttons.some((button) => button.text === label));
    if (message === undefined) throw new Error(`no bot message has a "${label}" button`);
    const button = message.buttons.find((entry) => entry.text === label)!;
    await pressButton(button.data, message.id, as);
  }

  /** Rows the connect-wizard guard wrote to the action log, oldest first, metadata decoded. */
  function auditRows() {
    return db.db
      .query<
        {
          user_id: number;
          chat_id: number;
          action_name: string;
          message_id: number | null;
          chat_history_id: number | null;
          metadata: string | null;
          success: number;
          created_at: string;
        },
        []
      >(
        `SELECT user_id, chat_id, action_name, message_id, chat_history_id, metadata, success, created_at
           FROM user_action_log WHERE action_type = 'connect_wizard_input' ORDER BY id`,
      )
      .all()
      .map((row) => ({ ...row, metadata: jsonCodec(AuditMetadataSchema).parse(row.metadata ?? '{}') }));
  }
  function historyRows() {
    return db.db
      .query<{ id: number; role: string; content: string }, []>(
        'SELECT id, role, content FROM chat_history ORDER BY id',
      )
      .all();
  }

  function storedText() {
    const history = db.db.query<{ content: string }, []>('SELECT content FROM chat_history').all();
    const actions = db.db.query<{ [key: string]: unknown }, []>('SELECT * FROM user_action_log').all();
    return { history: history.map((row) => row.content), actions: JSON.stringify(actions) };
  }
  function debugLogText() {
    return readdirSync(debugDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
      .join('\n');
  }

  return {
    db,
    userId,
    typed,
    send,
    edit,
    click,
    clickButton,
    pressButton,
    lastBotMessage: () => sent.at(-1)!,
    sent,
    toasts,
    commandsRun,
    auditRows,
    historyRows,
    failSceneReads: () => {
      sceneReadsFail = true;
    },
    restoreSceneReads: () => {
      sceneReadsFail = false;
    },
    restart: () => {
      bot = startBot();
    },
    /** Keeps Telegram's answer to deleting `messageId` back until the returned release is called. */
    holdDeletion(messageId: number) {
      const held = Promise.withResolvers<void>();
      heldDeletions.set(messageId, held.promise);
      return held.resolve;
    },
    /** From now on Telegram refuses every deleteMessage call. */
    refuseDeletions: () => {
      refuseDeletions = true;
    },
    /** From now on storing the connected session fails with an error that names the phone number. */
    failSessionSave: () => {
      const save = spyOn(db.telegramSessions, 'upsert').mockImplementation(() => {
        throw new Error(`synthetic store failure for ${PHONE}`);
      });
      cleanups.push(async () => save.mockRestore());
    },
    logText: () => logs.text(),
    /** Feature keys recorded in feature_usage for this user. */
    featureUsage: () =>
      db.db
        .query<{ feature_key: string; use_count: number }, [number]>(
          'SELECT feature_key, use_count FROM feature_usage WHERE user_id = ?',
        )
        .all(userId),
    deletedMessageIds,
    sessionPath,
    endedAuthFor: () => endAuth.mock.calls.map(([id]) => id),
    botReplies: () => sent.map((message) => message.text),
    reachedHandlers,
    aiTurns,
    storedText,
    debugLogText,
  };
}

async function reachPasswordStep(r: { send(text: string): Promise<number>; click(data: string): Promise<void> }) {
  await r.send('/connect_telegram');
  await r.click('ct:connect');
  const phoneMessageId = await r.send(TYPED_PHONE);
  const codeMessageId = await r.send(TYPED_CODE);
  return { phoneMessageId, codeMessageId };
}

describe('connect-telegram wizard input stays out of logs and the AI (GH-519)', () => {
  test('a completed phone → code → 2FA flow stores placeholders and the next AI turn sees no credential', async () => {
    const r = makeRuntime();
    const { phoneMessageId } = await reachPasswordStep(r);
    await r.edit(phoneMessageId, TYPED_PHONE);
    await r.send(PASSWORD);
    expect(r.db.telegramSessions.findByUserId(r.userId)?.status).toBe('active');

    await r.send('Что у меня завтра?');

    const { history, actions } = r.storedText();
    expect(history.flatMap(leakedSecrets)).toEqual([]);
    expect(leakedSecrets(actions)).toEqual([]);
    // Phone, code and password each leave a placeholder row, and the edit of the phone message too.
    expect(history.filter((content) => content.includes(CONNECT_WIZARD_REDACTION))).toHaveLength(4);
    expect(r.aiTurns).toHaveLength(1);
    expect(r.aiTurns[0]).toContain('Что у меня завтра?');
    expect(leakedSecrets(r.aiTurns[0]!)).toEqual([]);
    expect(r.debugLogText()).toContain('Что у меня завтра?');
    expect(leakedSecrets(r.debugLogText())).toEqual([]);
  });

  test('the messages carrying the phone number, the login code and the 2FA password are deleted from the chat', async () => {
    const r = makeRuntime();
    const { phoneMessageId, codeMessageId } = await reachPasswordStep(r);
    const passwordMessageId = await r.send(PASSWORD);
    const questionMessageId = await r.send('Что у меня завтра?');

    expect(r.deletedMessageIds).toContain(phoneMessageId);
    expect(r.deletedMessageIds).toContain(codeMessageId);
    expect(r.deletedMessageIds).toContain(passwordMessageId);
    expect(r.deletedMessageIds).not.toContain(questionMessageId);
  });

  test('text typed at the consent screen, before "Connect", leaves the chat and the logs', async () => {
    const r = makeRuntime();
    await r.send('/connect_telegram');
    // The password typed before the wizard asked for anything.
    const tooEarlyId = await r.send(PASSWORD);
    await r.clickButton(ct.btnCancel);

    expect(r.deletedMessageIds).toContain(tooEarlyId);
    expect(r.storedText().history.flatMap(leakedSecrets)).toEqual([]);
    expect(r.aiTurns).toEqual([]);
    const audit = r.auditRows().find((row) => row.message_id === tooEarlyId);
    expect([audit?.action_name, audit?.metadata.step, audit?.metadata.deletion]).toEqual([
      'typed',
      'consent',
      'deleted',
    ]);
  });

  test('anything typed at the code prompt stays out of the AI, even after a cancel', async () => {
    const r = makeRuntime();
    await r.send('/connect_telegram');
    await r.click('ct:connect');
    await r.send(TYPED_PHONE);
    // The 2FA password typed one prompt too early: plain words, nothing code-shaped to give it away.
    const earlyPasswordId = await r.send(PASSWORD);
    await r.clickButton(t('ru').connectTelegram.btnCancelAuth);

    expect(r.botReplies().at(-1)).toBe(t('ru').connectTelegram.authCancelled);
    expect(r.aiTurns).toEqual([]);
    expect(r.deletedMessageIds).toContain(earlyPasswordId);
    const { history, actions } = r.storedText();
    expect(history.flatMap(leakedSecrets)).toEqual([]);
    expect(leakedSecrets(actions)).toEqual([]);

    // The first AI turn after the cancelled flow sees none of what was typed into the wizard.
    await r.send('Что у меня завтра?');
    expect(r.aiTurns).toHaveLength(1);
    expect(r.aiTurns[0]).toContain('Что у меня завтра?');
    expect(leakedSecrets(r.aiTurns[0]!)).toEqual([]);
    expect(leakedSecrets(r.debugLogText())).toEqual([]);
  });

  test('anything typed at the phone prompt stays out of the AI, even after a cancel', async () => {
    const r = makeRuntime();
    await r.send('/connect_telegram');
    await r.click('ct:connect');
    const typedId = await r.send('покажи мои встречи на неделе');
    await r.clickButton(t('ru').connectTelegram.btnCancelAuth);

    expect(r.botReplies().at(-1)).toBe(t('ru').connectTelegram.authCancelled);
    expect(r.aiTurns).toEqual([]);
    expect(r.deletedMessageIds).toContain(typedId);
    expect(r.storedText().history).not.toContain('покажи мои встречи на неделе');
  });

  test('a 2FA password that starts with a slash closes the wizard and goes no further', async () => {
    const r = makeRuntime();
    await reachPasswordStep(r);
    const slashId = await r.send('/Synth2faSlash Qx9vTail');

    const { history, actions } = r.storedText();
    expect(history.filter((content) => content.includes('Synth2faSlash') || content.includes('Qx9vTail'))).toEqual([]);
    expect(actions).not.toContain('Synth2faSlash');
    expect(actions).not.toContain('Qx9vTail');
    expect(r.aiTurns).toEqual([]);
    // Not a command: no handler after the wizard sees it, the chat loses it, the wizard just ends.
    expect(r.reachedHandlers.filter((text) => text.includes('Synth2faSlash'))).toEqual([]);
    expect(r.deletedMessageIds).toContain(slashId);
    expect(r.botReplies().at(-1)).toBe(t('ru').connectTelegram.authCancelled);
    // Ended like the cancel button: the login process is stopped and its temp session file removed.
    expect(r.endedAuthFor()).toContain(r.userId);
    expect(existsSync(r.sessionPath)).toBe(false);
  });
});

interface WizardDriver {
  send(text: string): Promise<number>;
  click(data: string): Promise<void>;
  clickButton(label: string): Promise<void>;
}

/** Nothing typed into the wizard is in chat_history or the action log, and no AI turn ran. */
function expectNoCredentialKeptOrHandedOn(r: {
  storedText(): { history: string[]; actions: string };
  reachedHandlers: string[];
  aiTurns: string[];
}) {
  const { history, actions } = r.storedText();
  expect(history.flatMap(leakedSecrets)).toEqual([]);
  expect(leakedSecrets(actions)).toEqual([]);
  expect(r.reachedHandlers.flatMap(leakedSecrets)).toEqual([]);
  expect(r.aiTurns).toEqual([]);
}

describe('connect-wizard input on the rare paths around the wizard (GH-639)', () => {
  test.each([
    ['/cancel', (r: WizardDriver) => r.send('/cancel').then(() => undefined)],
    ['the cancel button', (r: WizardDriver) => r.clickButton(t('ru').connectTelegram.btnCancelAuth)],
  ])('a 2FA password handled after a later %s is neither stored nor handed on', async (_, cancel) => {
    const r = makeRuntime();
    await reachPasswordStep(r);
    // Typed before the cancel, but its webhook delivery is handled after it.
    const password = r.typed(PASSWORD);
    await cancel(r);
    await password.deliver();

    expect(r.botReplies()).toContain(t('ru').connectTelegram.authCancelled);
    expect(r.deletedMessageIds).toContain(password.id);
    expectNoCredentialKeptOrHandedOn(r);

    // Only what was typed before the cancel is held back.
    const questionId = await r.send('Что у меня завтра?');
    expect(r.deletedMessageIds).not.toContain(questionId);
    expect(r.aiTurns).toHaveLength(1);
    expect(leakedSecrets(r.aiTurns[0]!)).toEqual([]);
    expect(leakedSecrets(r.debugLogText())).toEqual([]);
  });

  test('a 2FA password whose wizard a /cancel closes while the password is in flight is neither stored nor handed on', async () => {
    const r = makeRuntime();
    await reachPasswordStep(r);
    const password = r.typed(PASSWORD);
    // The password is recognised as wizard input, then waits on Telegram deleting it…
    const releaseDeletion = r.holdDeletion(password.id);
    const passwordHandled = password.deliver();
    // …while the /cancel is handled completely and closes the wizard.
    await r.send('/cancel');
    expect(r.botReplies().at(-1)).toBe(t('ru').connectTelegram.authCancelled);
    releaseDeletion();
    await passwordHandled;

    expect(r.deletedMessageIds).toContain(password.id);
    expectNoCredentialKeptOrHandedOn(r);
    expect(r.botReplies().at(-1)).toBe(t('ru').connectTelegram.authCancelled);
  });

  test('a rate-limited password is deleted, and an edit of it after the wizard ended stores no password', async () => {
    // Four updates reach the password prompt: the command, "Connect", the phone and the code.
    const r = makeRuntime({ messagesPerMinute: 4 });
    await reachPasswordStep(r);
    const passwordId = await r.send(PASSWORD);
    expect(r.botReplies().at(-1)).toBe(t('ru').rate_limited);
    expect(r.deletedMessageIds).toContain(passwordId);

    advanceClock(2 * 60_000); // past the rate limiter's cooldown
    await r.send('/cancel');
    expect(r.botReplies().at(-1)).toBe(t('ru').connectTelegram.authCancelled);
    // What Telegram delivers if the deletion was refused and the user edits the message later.
    await r.edit(passwordId, PASSWORD);

    expectNoCredentialKeptOrHandedOn(r);
  });

  test('an edit of a password Telegram refused to delete is stored only as the marker after the wizard ended (GH-630)', async () => {
    const r = makeRuntime();
    await reachPasswordStep(r);
    r.refuseDeletions();
    const passwordId = await r.send(PASSWORD);
    expect(r.db.telegramSessions.findByUserId(r.userId)?.status).toBe('active'); // the wizard has ended
    await r.edit(passwordId, PASSWORD);

    expectNoCredentialKeptOrHandedOn(r);
    expect(r.storedText().history.at(-1)).toContain(CONNECT_WIZARD_REDACTION);
  });

  test('a password typed after the idle wizard expired at the 2FA prompt is deleted and kept from logs and the AI, across a restart', async () => {
    const r = makeRuntime();
    await reachPasswordStep(r);
    r.restart();
    advanceClock(31 * 60_000); // the scene store forgets a wizard idle for 30 minutes
    const passwordId = await r.send(PASSWORD);

    expect(r.deletedMessageIds).toContain(passwordId);
    expect(r.botReplies().at(-1)).toBe(t('ru').connectTelegram.wizardExpired);
    expectNoCredentialKeptOrHandedOn(r);
    // Discarding it keeps it out for good.
    await r.clickButton(DISCARD_LABEL);
    expectNoCredentialKeptOrHandedOn(r);

    // Only the answer to the abandoned prompt is held back: the next message is ordinary again.
    const questionId = await r.send('Что у меня завтра?');
    expect(r.deletedMessageIds).not.toContain(questionId);
    expect(r.aiTurns).toHaveLength(1);
    expect(r.aiTurns[0]).toContain('Что у меня завтра?');
    expect(leakedSecrets(r.aiTurns[0]!)).toEqual([]);
    expect(leakedSecrets(r.debugLogText())).toEqual([]);
  });

  test.each([
    [
      'after a finished connection',
      async (r: WizardDriver) => {
        await reachPasswordStep(r);
        await r.send(PASSWORD);
      },
    ],
    ['after the consent screen was left open', (r: WizardDriver) => r.send('/connect_telegram').then(() => undefined)],
  ])('a message typed half an hour %s is an ordinary message', async (_, leaveWizard) => {
    const r = makeRuntime();
    await leaveWizard(r);
    advanceClock(31 * 60_000);
    const questionId = await r.send('Что у меня завтра?');

    expect(r.deletedMessageIds).not.toContain(questionId);
    expect(r.aiTurns).toHaveLength(1);
    expect(r.aiTurns[0]).toContain('Что у меня завтра?');
  });
});

const ct = t('ru').connectTelegram;
const QUESTION = 'Что у меня завтра?';

/** The wizard is left at the 2FA prompt until the scene store forgets it. */
async function expireAtPasswordStep(r: WizardDriver) {
  await reachPasswordStep(r);
  advanceClock(31 * 60_000);
}

describe('a request typed after the wizard expired is held until the owner releases it', () => {
  test('an ordinary question is held without an echo, then processed exactly once after "process it"', async () => {
    const r = makeRuntime();
    await expireAtPasswordStep(r);
    const questionId = await r.send(QUESTION);

    expect(r.deletedMessageIds).toContain(questionId);
    const notice = r.lastBotMessage();
    expect(notice.text).toBe(ct.wizardExpired);
    expect(notice.buttons.map((button) => button.text)).toEqual([PROCESS_LABEL, DISCARD_LABEL]);
    // Neither the notice nor its buttons carry the text.
    expect(JSON.stringify(notice)).not.toContain(QUESTION);
    expect(r.aiTurns).toEqual([]);
    expect(r.historyRows().some((row) => row.content.includes(QUESTION))).toBe(false);

    await r.clickButton(PROCESS_LABEL);
    expect(r.aiTurns).toHaveLength(1);
    expect(r.aiTurns[0]).toContain(QUESTION);
    expect(r.reachedHandlers.filter((text) => text === QUESTION)).toHaveLength(1);

    // A second press of the same button (a stale or replayed callback) processes nothing.
    await r.clickButton(PROCESS_LABEL);
    expect(r.aiTurns).toHaveLength(1);
    expect(r.reachedHandlers.filter((text) => text === QUESTION)).toHaveLength(1);

    // History keeps the true order: the marker, the notice, the press, then the released question.
    const rows = r.historyRows();
    const markerAt = rows.findLastIndex((row) => row.content === CONNECT_WIZARD_REDACTION);
    const tail = rows.slice(markerAt).map((row) => row.content);
    expect(tail[1]).toContain('Время на подключение Telegram вышло');
    expect(tail[2]).toContain(PROCESS_LABEL);
    expect(tail.filter((content) => content === QUESTION)).toHaveLength(1);
    expect(tail.indexOf(QUESTION)).toBeGreaterThan(2);
  });

  test('a held command runs through the ordinary command routing once released, not the AI', async () => {
    const r = makeRuntime();
    await expireAtPasswordStep(r);
    await r.send('/today');
    expect(r.commandsRun).toEqual([]);

    await r.clickButton(PROCESS_LABEL);
    expect(r.commandsRun).toEqual(['today']);
    expect(r.aiTurns).toEqual([]);
  });

  test('"Discard" drops the held text at once: nothing is processed, and a later "process it" says it is gone', async () => {
    const r = makeRuntime();
    await expireAtPasswordStep(r);
    await r.send(QUESTION);
    await r.clickButton(DISCARD_LABEL);
    await r.clickButton(PROCESS_LABEL);

    expect(r.aiTurns).toEqual([]);
    expect(r.reachedHandlers).not.toContain(QUESTION);
    expect(r.botReplies().some(isResendNotice)).toBe(true);
  });

  test('after a restart the held text is gone: "process it" asks to resend and processes nothing', async () => {
    const r = makeRuntime();
    await expireAtPasswordStep(r);
    await r.send(QUESTION);
    r.restart();
    await r.clickButton(PROCESS_LABEL);

    expect(r.aiTurns).toEqual([]);
    expect(r.reachedHandlers).not.toContain(QUESTION);
    expect(isResendNotice(r.botReplies().at(-1) ?? '')).toBe(true);
  });

  test('held text expires after a short while and is not processed later', async () => {
    const r = makeRuntime();
    await expireAtPasswordStep(r);
    await r.send(QUESTION);
    advanceClock(16 * 60_000);
    await r.clickButton(PROCESS_LABEL);

    expect(r.aiTurns).toEqual([]);
    expect(isResendNotice(r.botReplies().at(-1) ?? '')).toBe(true);
  });

  test('a press from another user or from another chat releases nothing, and the owner still can', async () => {
    const r = makeRuntime();
    await expireAtPasswordStep(r);
    await r.send(QUESTION);
    await r.clickButton(PROCESS_LABEL, { userId: r.userId + 500_000 });
    await r.clickButton(PROCESS_LABEL, { chatId: r.userId + 500_000 });
    expect(r.aiTurns).toEqual([]);
    expect(r.reachedHandlers).not.toContain(QUESTION);

    await r.clickButton(PROCESS_LABEL);
    expect(r.aiTurns).toHaveLength(1);
    expect(r.aiTurns[0]).toContain(QUESTION);
  });

  test('a slash-shaped password typed after expiry never runs as a command unless released', async () => {
    const r = makeRuntime();
    await expireAtPasswordStep(r);
    await r.send('/today Synth2faSlash');
    await r.clickButton(DISCARD_LABEL);

    expect(r.commandsRun).toEqual([]);
    expect(r.reachedHandlers).toEqual([]);
    expect(r.storedText().history.some((content) => content.includes('Synth2faSlash'))).toBe(false);
    expect(r.storedText().actions).not.toContain('Synth2faSlash');
  });

  test('when the scene store cannot be read while the wizard is open, the text is held, not handled or logged', async () => {
    const r = makeRuntime();
    await reachPasswordStep(r);
    r.failSceneReads();
    const passwordId = await r.send(PASSWORD);

    expect(r.deletedMessageIds).toContain(passwordId);
    expect(r.lastBotMessage().buttons.map((button) => button.text)).toEqual([PROCESS_LABEL, DISCARD_LABEL]);
    expect(JSON.stringify(r.lastBotMessage())).not.toContain(PASSWORD);
    expectNoCredentialKeptOrHandedOn(r);
    expect(r.auditRows().find((row) => row.message_id === passwordId)?.action_name).toBe('state_unreadable');
  });

  test('when the scene store cannot be read but this chat never opened the wizard, the message is ordinary', async () => {
    const r = makeRuntime();
    r.failSceneReads();
    const questionId = await r.send(QUESTION);

    expect(r.deletedMessageIds).not.toContain(questionId);
    expect(r.aiTurns).toHaveLength(1);
    expect(r.aiTurns[0]).toContain(QUESTION);
    expect(r.storedText().history).toContain(QUESTION);
    expect(r.auditRows()).toEqual([]);
  });
});

describe('every protected input leaves one safe history row and one audit row', () => {
  test('opening the wizard, then typed, edited and slash input: reason, step, message id and deletion, never the text', async () => {
    const r = makeRuntime();
    const openId = await r.send('/connect_telegram');
    await r.click('ct:connect');
    const phoneId = await r.send(TYPED_PHONE);
    await r.edit(phoneId, TYPED_PHONE);
    const codeId = await r.send(TYPED_CODE);
    const slashId = await r.send('/Synth2faSlash Qx9vTail');

    const audit = r.auditRows();
    expect(audit.map((row) => [row.action_name, row.message_id, row.metadata.step])).toEqual([
      ['opened', openId, 'consent'],
      ['typed', phoneId, 'phone'],
      ['edited', phoneId, 'code'],
      ['typed', codeId, 'code'],
      ['slash', slashId, 'password'],
    ]);
    expect(audit[0]!.metadata.outcome).toBe('opened');
    for (const row of audit) {
      expect(row.user_id).toBe(r.userId);
      expect(row.chat_id).toBe(r.userId);
      expect(row.created_at).toBeTruthy();
    }
    const inputs = audit.slice(1);
    expect(inputs.filter((row) => row.action_name !== 'edited').map((row) => row.metadata.deletion)).toEqual([
      'deleted',
      'deleted',
      'deleted',
    ]);
    // Each input's audit row points at its one marker row; no input got a second history row.
    const markers = r.historyRows().filter((row) => row.content.includes(CONNECT_WIZARD_REDACTION));
    expect(markers).toHaveLength(4);
    expect(inputs.map((row) => row.chat_history_id)).toEqual(markers.map((row) => row.id));
    const auditText = JSON.stringify(audit);
    expect(leakedSecrets(auditText)).toEqual([]);
    expect(auditText).not.toContain('Synth2faSlash');
  });

  test('a password handled after a concurrent /cancel leaves a marker and a "late" audit row', async () => {
    const r = makeRuntime();
    await reachPasswordStep(r);
    const password = r.typed(PASSWORD);
    await r.send('/cancel');
    await password.deliver();

    const late = r.auditRows().filter((row) => row.message_id === password.id);
    expect(late.map((row) => [row.action_name, row.metadata.deletion])).toEqual([['late', 'deleted']]);
    expect(r.historyRows().find((row) => row.id === late[0]!.chat_history_id)?.content).toBe(CONNECT_WIZARD_REDACTION);
    expectNoCredentialKeptOrHandedOn(r);
  });

  test('a rate-limited password leaves one marker and an audit row that says it was rate-limited', async () => {
    const r = makeRuntime({ messagesPerMinute: 4 });
    await reachPasswordStep(r);
    const passwordId = await r.send(PASSWORD);

    const rows = r.auditRows().filter((row) => row.message_id === passwordId);
    expect(rows.map((row) => row.action_name)).toEqual(['typed', 'rate_limited']);
    expect(new Set(rows.map((row) => row.chat_history_id)).size).toBe(1);
    expectNoCredentialKeptOrHandedOn(r);
  });

  test('a deletion Telegram refused is recorded as failed, without the text', async () => {
    const r = makeRuntime();
    await reachPasswordStep(r);
    r.refuseDeletions();
    const passwordId = await r.send(PASSWORD);

    const row = r.auditRows().find((entry) => entry.message_id === passwordId)!;
    expect(row.metadata.deletion).toBe('failed');
    expect(row.success).toBe(0);
    expect(leakedSecrets(JSON.stringify(r.auditRows()))).toEqual([]);
    expect(r.logText()).toContain('failed to delete a message typed into the connect wizard');
    expect(leakedSecrets(r.logText())).toEqual([]);
  });

  test('a bridge error naming the phone number and a failing session save leave no credential in the logs', async () => {
    const failing = makeRuntime({ sendCodeFailure: `Synthetic bridge failure for ${PHONE}` });
    await failing.send('/connect_telegram');
    await failing.click('ct:connect');
    await failing.send(TYPED_PHONE);
    expect(failing.botReplies().at(-1)).toBe(ct.featureUnavailable);
    expect(failing.logText()).toContain('sendCode failed');
    expect(leakedSecrets(failing.logText())).toEqual([]);

    const r = makeRuntime();
    await reachPasswordStep(r);
    r.failSessionSave();
    await r.send(PASSWORD);
    expect(r.botReplies().at(-1)).toBe(ct.featureUnavailable);
    expect(r.logText()).toContain('Failed to finalize session');
    expect(leakedSecrets(r.logText())).toEqual([]);
  });

  test('an expired-prompt answer leaves a marker, a "held" audit row and the logged notice; the release is audited', async () => {
    const r = makeRuntime();
    await expireAtPasswordStep(r);
    const questionId = await r.send(QUESTION);
    await r.clickButton(PROCESS_LABEL);

    const rows = r.auditRows().filter((row) => row.message_id === questionId);
    expect(rows.map((row) => [row.action_name, row.metadata.step, row.metadata.outcome])).toEqual([
      ['expired', 'password', 'held'],
      ['released', 'password', 'processing'],
      ['replayed', 'password', 'handled'],
    ]);
    const history = r.historyRows();
    const markerIndex = history.findIndex((row) => row.id === rows[0]!.chat_history_id);
    expect(history[markerIndex]!.content).toBe(CONNECT_WIZARD_REDACTION);
    expect(history[markerIndex + 1]!.role).toBe('assistant');
    expect(history[markerIndex + 1]!.content).toContain('Время на подключение Telegram вышло');
  });

  test('ordinary messages outside the wizard are logged verbatim with no audit rows', async () => {
    const r = makeRuntime();
    const questionId = await r.send(QUESTION);
    await r.send('/today');

    expect(r.deletedMessageIds).not.toContain(questionId);
    expect(r.storedText().history).toContain(QUESTION);
    expect(r.auditRows()).toEqual([]);
    expect(r.aiTurns).toHaveLength(1);
    expect(r.commandsRun).toEqual(['today']);
  });
});

describe('a cancel button pressed after the wizard is gone', () => {
  test("the consent screen's Cancel, pressed after that screen expired, closes it with the cancel reply", async () => {
    const r = makeRuntime();
    await r.send('/connect_telegram');
    advanceClock(31 * 60_000);
    await r.clickButton(ct.btnCancel);

    expect(r.botReplies().at(-1)).toBe(ct.cancelled);
    const questionId = await r.send(QUESTION);
    expect(r.deletedMessageIds).not.toContain(questionId);
    expect(r.aiTurns).toHaveLength(1);
  });

  test("the consent screen's Cancel from an earlier attempt does not cancel a newer one", async () => {
    const r = makeRuntime();
    await r.send('/connect_telegram');
    const earlier = r.sent.findLast((message) => message.buttons.some((button) => button.text === ct.btnCancel))!;
    const earlierCancel = earlier.buttons.find((button) => button.text === ct.btnCancel)!;
    await r.send('/cancel');
    await r.send('/connect_telegram');
    await r.pressButton(earlierCancel.data, earlier.id);
    expect(r.botReplies()).not.toContain(ct.cancelled);

    // The newer consent screen still connects.
    await r.clickButton(ct.btnConnect);
    expect(r.botReplies().at(-1)).toBe(ct.enterPhone);
  });

  test('after the wizard expired, its cancel button closes it and the next request is handled normally', async () => {
    const r = makeRuntime();
    await expireAtPasswordStep(r);
    await r.clickButton(ct.btnCancelAuth);

    expect(r.botReplies().at(-1)).toBe(ct.authCancelled);
    expect(r.endedAuthFor()).toContain(r.userId);
    // Like the cancel in an open wizard: the login's temp session file is removed too.
    expect(existsSync(r.sessionPath)).toBe(false);
    const questionId = await r.send(QUESTION);
    expect(r.deletedMessageIds).not.toContain(questionId);
    expect(r.aiTurns).toHaveLength(1);
    expect(r.aiTurns[0]).toContain(QUESTION);
  });

  test('a cancel button from an earlier attempt does not cancel a newer connection', async () => {
    const r = makeRuntime();
    await r.send('/connect_telegram');
    await r.click('ct:connect');
    const earlier = r.sent.findLast((message) => message.buttons.some((button) => button.text === ct.btnCancelAuth))!;
    const earlierCancel = earlier.buttons.find((button) => button.text === ct.btnCancelAuth)!;
    await r.send('/cancel');

    advanceClock(61_000); // past the reconnect cooldown
    await r.send('/connect_telegram');
    await r.click('ct:connect');
    await r.pressButton(earlierCancel.data, earlier.id);
    expect(r.botReplies().filter((text) => text === ct.authCancelled)).toHaveLength(1);

    // The newer wizard still takes the phone number.
    await r.send(TYPED_PHONE);
    expect(r.botReplies().at(-1)).toBe(ct.codeSent);
    expectNoCredentialKeptOrHandedOn(r);
  });
});

describe('feature usage and memory stay bounded around held messages', () => {
  test('slash text is counted as a command only once its owner released it', async () => {
    const r = makeRuntime();
    const uses = () => r.featureUsage().reduce((sum, row) => sum + row.use_count, 0);
    await r.send('/connect_telegram');
    await r.click('ct:connect');
    const beforeSlash = uses();
    await r.send('/today Synth2faSlash');
    expect(uses()).toBe(beforeSlash);

    advanceClock(61_000); // past the reconnect cooldown
    await expireAtPasswordStep(r);
    await r.send('/today');
    const beforeRelease = uses();
    expect(r.commandsRun).toEqual([]);
    await r.clickButton(PROCESS_LABEL);
    expect(uses()).toBe(beforeRelease + 1);
    expect(r.commandsRun).toEqual(['today']);
  });

  test('a user holds at most three messages; the oldest is dropped and says so when pressed', async () => {
    const r = makeRuntime();
    await reachPasswordStep(r);
    r.failSceneReads();
    for (const text of ['synthetic one', 'synthetic two', 'synthetic three', 'synthetic four']) await r.send(text);
    const notices = r.sent.filter((message) => message.buttons.some((button) => button.text === PROCESS_LABEL));
    expect(notices).toHaveLength(4);

    const oldest = notices[0]!.buttons.find((button) => button.text === PROCESS_LABEL)!;
    await r.pressButton(oldest.data, notices[0]!.id);
    expect(isResendNotice(r.botReplies().at(-1) ?? '')).toBe(true);
    expect(r.reachedHandlers).toEqual([]);

    // The store is readable again when the owner releases the newest one.
    r.restoreSceneReads();
    const newest = notices[3]!.buttons.find((button) => button.text === PROCESS_LABEL)!;
    await r.pressButton(newest.data, notices[3]!.id);
    expect(r.reachedHandlers).toEqual(['synthetic four']);
  });
});

describe('releasing a message held because the wizard state could not be read', () => {
  test('ends that wizard first, then runs the text through the ordinary routing, not the wizard', async () => {
    const r = makeRuntime();
    await reachPasswordStep(r);
    r.failSceneReads();
    await r.send(QUESTION);
    r.restoreSceneReads();
    await r.clickButton(PROCESS_LABEL);

    expect(r.endedAuthFor()).toContain(r.userId);
    expect(r.botReplies()).toContain(ct.authCancelled);
    expect(r.db.telegramSessions.findByUserId(r.userId)).toBeNull();
    expect(r.reachedHandlers).toEqual([QUESTION]);
    expect(r.aiTurns).toHaveLength(1);
    expect(r.aiTurns[0]).toContain(QUESTION);
  });

  test('a released command runs as a command once that wizard is ended', async () => {
    const r = makeRuntime();
    await reachPasswordStep(r);
    r.failSceneReads();
    await r.send('/today');
    r.restoreSceneReads();
    await r.clickButton(PROCESS_LABEL);

    expect(r.commandsRun).toEqual(['today']);
    expect(r.endedAuthFor()).toContain(r.userId);
    expect(r.aiTurns).toEqual([]);
  });

  test('while the state still cannot be read, "process it" processes nothing and asks to resend', async () => {
    const r = makeRuntime();
    await reachPasswordStep(r);
    r.failSceneReads();
    await r.send(QUESTION);
    await r.clickButton(PROCESS_LABEL);

    expect(isResendNotice(r.botReplies().at(-1) ?? '')).toBe(true);
    expect(r.reachedHandlers).toEqual([]);
    expect(r.aiTurns).toEqual([]);
    // Single use: a second press cannot release it either.
    r.restoreSceneReads();
    await r.clickButton(PROCESS_LABEL);
    expect(r.reachedHandlers).toEqual([]);
  });

  test('a message held after expiry is not fed into a newer wizard opened meanwhile', async () => {
    const r = makeRuntime();
    await expireAtPasswordStep(r);
    await r.send(QUESTION);
    await r.send('/connect_telegram');
    await r.click('ct:connect');
    await r.clickButton(PROCESS_LABEL);

    expect(isResendNotice(r.botReplies().at(-1) ?? '')).toBe(true);
    expect(r.reachedHandlers).toEqual([]);
    // The newer wizard still waits for its phone number.
    await r.send(TYPED_PHONE);
    expect(r.botReplies().at(-1)).toBe(ct.codeSent);
  });
});

describe('the masked phone is shown to the user but kept out of history and the AI (GH-643)', () => {
  test('success, already-connected and /settings show it; chat history, the next AI turn and its debug log do not', async () => {
    const r = makeRuntime();
    // A number from Ofcom's range reserved for fiction: valid, so maskPhone keeps its last four digits.
    const typedPhone = '+44 20 7946 0958';
    const masked = maskPhone('+442079460958');
    // Every form the number could leak in. Its two-digit groups ("44", "20") are checked with the
    // leading "+" or as part of the longer forms: on their own they occur in any date or time.
    const phoneForms = ['+442079460958', '442079460958', typedPhone, '+44', '7946', '0958'];
    expect(masked).toContain('0958');
    await r.send('/connect_telegram');
    await r.click('ct:connect');
    await r.send(typedPhone);
    await r.send(TYPED_CODE);
    await r.send(PASSWORD);

    expect(r.botReplies()).toContain(ct.success(masked));
    advanceClock(61_000); // past the reconnect cooldown
    await r.send('/connect_telegram');
    expect(r.botReplies().at(-1)).toBe(ct.alreadyConnected(masked));
    await r.clickButton(ct.btnCancel);
    await r.pressButton('stg:telegram', r.lastBotMessage().id);
    expect(r.botReplies().at(-1)).toBe(t('ru').settings.telegramConnected(masked));

    await r.send(QUESTION);
    const history = r.storedText().history;
    const leaks = (haystack: string) => phoneForms.filter((form) => haystack.includes(form));
    expect(history.flatMap(leaks)).toEqual([]);
    expect(leaks(r.storedText().actions)).toEqual([]);
    // The replies stay in history, only the account number is left out.
    expect(history.some((content) => content.includes('Telegram-аккаунт подключён'))).toBe(true);
    expect(history.some((content) => content.includes('Telegram: подключён'))).toBe(true);
    expect(r.aiTurns).toHaveLength(1);
    expect(leaks(r.aiTurns[0]!)).toEqual([]);
    expect(leaks(r.debugLogText())).toEqual([]);
  });
});

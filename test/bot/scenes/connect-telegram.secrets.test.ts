/**
 * The connect-telegram wizard collects a phone number, a login code and a 2FA password.
 * Drives the real GramIO chain in production order (chat logging → command escape →
 * scenes) against a real in-memory database, then checks every place the bot keeps or
 * forwards conversation text: chat_history, action_log, the next AI turn and its debug log.
 * All credentials here are synthetic.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scenes } from '@gramio/scenes';
import { Bot } from 'gramio';
import { z } from 'zod';
import { createCallbackFallback } from '../../../src/bot/middleware/callback-fallback.ts';
import { createChatLogging } from '../../../src/bot/middleware/chat-logging.ts';
import { createSceneCommandEscape } from '../../../src/bot/middleware/scene-command-escape.ts';
import { createUserResolver, createUserResolverComposer } from '../../../src/bot/middleware/user-resolver.ts';
import { runWithChatId } from '../../../src/bot/scenes/chat-scoped-storage.ts';
import {
  CONNECT_WIZARD_REDACTION,
  createConnectTelegramScene,
} from '../../../src/bot/scenes/connect-telegram.scene.ts';
import { createScopedSceneStorage } from '../../../src/bot/scenes/index.ts';
import { t } from '../../../src/config/constants.ts';
import { DatabaseService } from '../../../src/database/index.ts';
import type { User } from '../../../src/database/types.ts';
import { type AgentRunResult, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { AiDebugLogger } from '../../../src/services/ai/debug-logger.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';
import { jsonCodec } from '../../../src/utils/json-codec.ts';

const TYPED_PHONE = '+1 555 010 4471';
const PHONE = '+15550104471';
const TYPED_CODE = '97 531';
const CODE = '97531';
const PASSWORD = 'Synth-2FA pass phrase';
const SECRETS = [TYPED_PHONE, PHONE, TYPED_CODE, CODE, PASSWORD];

const RequestSchema = z.object({
  text: z.string().optional(),
  message_id: z.number().optional(),
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

let nextUserId = 719_000;

function leakedSecrets(haystack: string): string[] {
  return SECRETS.filter((secret) => haystack.includes(secret));
}

function makeRuntime() {
  const db = new DatabaseService(':memory:');
  const userId = nextUserId++;
  const chat = { id: userId, type: 'private' as const };
  db.users.create({ telegram_id: userId, language: 'ru', timezone: 'Europe/Belgrade' });
  const storage = createScopedSceneStorage(db);
  const conversationLogger = new ConversationLogger(db.chatHistory);
  const tmp = mkdtempSync(path.join(tmpdir(), 'connect-secrets-'));
  const debugDir = path.join(tmp, 'debug');

  const sent: { id: number; text: string }[] = [];
  const deletedMessageIds: number[] = [];
  let outgoing = 1000;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const payload = jsonCodec(RequestSchema).parse(await request.text());
      const method = new URL(request.url).pathname.split('/').at(-1);
      if (method === 'answerCallbackQuery') return Response.json({ ok: true, result: true });
      if (method === 'deleteMessage') {
        if (payload.message_id !== undefined) deletedMessageIds.push(payload.message_id);
        return Response.json({ ok: true, result: true });
      }
      const id = outgoing++;
      sent.push({ id, text: payload.text ?? '' });
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
    spyOn(SessionBridge, 'spawnSendAndSign').mockResolvedValue({
      success: true,
      data: { phone_code_hash: 'synthetic-hash' },
    }),
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

  // Texts that got past the scene and the command escape to the bot's own message handlers.
  const reachedHandlers: string[] = [];
  const errors: Error[] = [];
  const bot = new Bot('1:synthetic-test', {
    info: { id: 1, is_bot: true, first_name: 'Bot', username: 'SyntheticTestBot' },
    api: { baseURL: `http://127.0.0.1:${server.port}/bot` },
  })
    .derive(createUserResolver(db))
    // Same chat scoping as src/bot/index.ts, which does not scope edited messages either.
    .use((context, next) =>
      runWithChatId(context.update?.message?.chat?.id ?? context.update?.callback_query?.message?.chat?.id ?? 0, next),
    )
    .use(
      createChatLogging({
        conversationLogger,
        actionLog: db.actionLog,
        chatHistoryIds: new Map<number, number>(),
        sceneStorage: storage,
      }),
    )
    .use(createSceneCommandEscape(storage))
    .use(createCallbackFallback(storage))
    .extend(scenes([scene], { storage }))
    .command('connect_telegram', (ctx) => ctx.scene.enter(scene))
    .on('message', async (ctx) => {
      if (ctx.text) reachedHandlers.push(ctx.text);
      // Like the message handler: slash text never starts an AI turn.
      if (!ctx.dbUser || !ctx.text || ctx.text.startsWith('/')) return;
      await runAgent(buildContext(ctx.dbUser, userId, ctx.text));
    });
  bot.onError((ctx) => {
    errors.push(ctx.error);
  });

  cleanups.push(() => {
    for (const spy of spies) spy.mockRestore();
    server.stop(true);
    db.db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  let incoming = 1;
  const from = { id: userId, is_bot: false, first_name: 'Synthetic' };
  async function send(text: string): Promise<number> {
    const messageId = incoming++;
    await bot.updates.handleUpdate({
      update_id: messageId,
      message: {
        message_id: messageId,
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
    return messageId;
  }
  async function edit(messageId: number, text: string) {
    await bot.updates.handleUpdate({
      update_id: incoming++,
      edited_message: { message_id: messageId, date: 1, edit_date: 2, chat, from, text },
    });
    expect(errors).toEqual([]);
  }
  async function click(data: string) {
    const messageId = sent.at(-1)!.id;
    await bot.updates.handleUpdate({
      update_id: incoming++,
      callback_query: {
        id: String(incoming),
        chat_instance: 'synthetic',
        data,
        from,
        message: { message_id: messageId, date: 1, chat },
      },
    });
    expect(errors).toEqual([]);
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
    send,
    edit,
    click,
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
    await r.click('ct:cancel');

    expect(r.deletedMessageIds).toContain(tooEarlyId);
    expect(r.storedText().history.flatMap(leakedSecrets)).toEqual([]);
    expect(r.aiTurns).toEqual([]);
  });

  test('anything typed at the code prompt stays out of the AI, even after a cancel', async () => {
    const r = makeRuntime();
    await r.send('/connect_telegram');
    await r.click('ct:connect');
    await r.send(TYPED_PHONE);
    // The 2FA password typed one prompt too early: plain words, nothing code-shaped to give it away.
    const earlyPasswordId = await r.send(PASSWORD);
    await r.click('ct:cancel_auth');

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
    await r.click('ct:cancel_auth');

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

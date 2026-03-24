// src/bot/handlers/message.handler.ts

import { TZDate } from '@date-fns/tz';
import type { AnyScene } from '@gramio/scenes';
import { format } from 'date-fns';
import { InlineKeyboard } from 'gramio';
import type { AgentDispatcher } from '../../agent/dispatcher.ts';
import type { AgentRegistry } from '../../agent/registry.ts';
import { t } from '../../config/constants.ts';
import type { CalendarProposalRepository } from '../../database/repositories/calendar-proposal.repository.ts';
import type { ChatHistoryRepository } from '../../database/repositories/chat-history.repository.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { EditProposalRepository } from '../../database/repositories/edit-proposal.repository.ts';
import type { FeedbackRepository } from '../../database/repositories/feedback.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { GroupMemberRepository } from '../../database/repositories/group-member.repository.ts';
import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { ParticipantRepository } from '../../database/repositories/participant.repository.ts';
import type { ReminderRepository } from '../../database/repositories/reminder.repository.ts';
import type { SecretaryRepository } from '../../database/repositories/secretary.repository.ts';
import type { SharedEventRepository } from '../../database/repositories/shared-event.repository.ts';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { CalendarEvent, User } from '../../database/types.ts';
import type { CalendarBotAgent } from '../../services/ai/agent.ts';
import { executeTool } from '../../services/ai/tool-executor.ts';
import type { AgentContext } from '../../services/ai/types.ts';
import type { BirthdayService } from '../../services/birthday/birthday-service.ts';
import type { ConversationLogger } from '../../services/conversation-logger.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { sendAdminReplyToUser } from '../../services/feedback/admin-messenger.ts';
import type { GroupSessionManager } from '../../services/group/group-session.ts';
import type { GroupMemberService } from '../../services/group/member-service.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import { type AdminEditSession, isSessionExpired } from '../../services/intent/admin-edit-session.ts';
import { type EventMentionStore, InMemoryEventMentionStore } from '../../services/intent/event-mention-store.ts';
import type { IntentExecutor } from '../../services/intent/intent-executor.ts';
import type { IntentLearner } from '../../services/intent/intent-learner.ts';
import type { IntentMatcher } from '../../services/intent/intent-matcher.ts';
import type { EventSummary } from '../../services/intent/variable-resolver.ts';
import type { ScenePauseService } from '../../services/scene-pause.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import type { PrivacyService } from '../../services/sharing/privacy-service.ts';
import type { SharingService } from '../../services/sharing/sharing-service.ts';
import { resolveCity } from '../../services/timezone/city-resolver.ts';
import { getTimezoneDisplay } from '../../services/timezone/timezone-service.ts';
import type { KokoroTtsService } from '../../services/voice/kokoro-tts-service.ts';
import type { SileroTtsService } from '../../services/voice/silero-tts-service.ts';
import {
  fixDateOrdinals,
  fixLineBreaks,
  markStress,
  numbersToWords,
  stripMarkdown,
  transliterateEnglish,
} from '../../services/voice/stress-marker.ts';
import type { TranscriptionService } from '../../services/voice/transcription-service.ts';
import { parseSimpleDate } from '../../utils/date.ts';
import { formatProposedTime } from '../../utils/invite-time-format.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { pendingDurationInput, pendingGroupTzInput } from '../commands/settings.ts';
import { createAiAgentLayer } from '../pipeline/ai-agent-layer.ts';
import { createFeedbackRouterLayer } from '../pipeline/feedback-router-layer.ts';
import { createIntentMatcherLayer } from '../pipeline/intent-matcher-layer.ts';
import { runPipeline } from '../pipeline/pipeline.ts';
import type { WorkflowSession, WorkflowSessionStore } from '../pipeline/types.ts';
import { CALLBACK_ONLY_STEP_INDICES } from '../scenes/add-event.scene.ts';
import type { BotCommandContext } from '../types.ts';

interface SceneStorage {
  get(key: string): Promise<unknown>;
  delete(key: string): unknown;
}

export interface MessageHandlerDeps {
  agent: CalendarBotAgent;
  eventService: EventService;
  holidayService: HolidayService;
  chatHistory: ChatHistoryRepository;
  conversationLogger: ConversationLogger;
  userRepo: UserRepository;
  reminderRepo: ReminderRepository;
  contactRepo?: ContactRepository;
  participantRepo?: ParticipantRepository;
  editProposalRepo?: EditProposalRepository;
  secretaryRepo?: SecretaryRepository;
  calendarProposalRepo?: CalendarProposalRepository;
  checkGroupMembership?: (chatId: number, userId: number) => Promise<boolean>;
  invitationService?: InvitationService;
  invitationRepo?: InvitationRepository;
  sharingService?: SharingService;
  sharingSettingsRepo?: SharingSettingsRepository;
  sharedEventRepo?: SharedEventRepository;
  privacyService?: PrivacyService;
  renderService?: RenderService;
  notificationPrefs?: AgentContext['notificationPrefs'];
  callQueue?: AgentContext['callQueue'];
  callSettingsRepo?: AgentContext['callSettingsRepo'];
  googleCalendarRepo?: GoogleCalendarRepository;
  deepLinkService?: DeepLinkService;
  sceneStorage: SceneStorage;
  botUsername?: string;
  botId?: number;
  groupSessions?: GroupSessionManager;
  groupMemberRepo?: GroupMemberRepository;
  groupChatRepo?: GroupChatRepository;
  groupMemberService?: GroupMemberService;
  transcriptionService?: TranscriptionService;
  botToken?: string;
  downloadVoiceBuffer?: (botToken: string, fileId: string) => Promise<Buffer>;
  stressDictionary?: AgentContext['stressDictionary'];
  resolveUsername?: AgentContext['resolveUsername'];
  sileroTts?: SileroTtsService;
  kokoroTts?: KokoroTtsService;
  fallbackTts?: { synthesize: (text: string, lang: string) => Promise<Buffer> };
  sendVoice?: (chatId: number, audio: Buffer) => Promise<void>;
  // Persistent store for last-mentioned event context (Redis-backed or in-memory)
  eventMentionStore?: EventMentionStore;
  // Pipeline: intent matching
  intentMatcher?: IntentMatcher;
  intentRepo?: IntentRepository;
  intentExecutor?: IntentExecutor;
  workflowSessions?: WorkflowSessionStore;
  // Pipeline: intent learning
  intentLearner?: IntentLearner;
  aiCityModel?: string;
  // Pipeline: feedback routing
  feedbackRepo?: FeedbackRepository;
  // Admin reply sessions: adminId → { threadId, userId }
  adminReplySession?: Map<number, { threadId: number; userId: number }>;
  botAdminId?: number;
  sendMessageToUser?: (chatId: number, text: string) => Promise<void>;
  // Admin intent edit sessions
  adminEditSessions?: Map<number, AdminEditSession>;
  aiBaseUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
  proposeTimeSessions?: Map<number, { invitationId: number }>;
  editMessage?: (chatId: number, messageId: number, text: string) => Promise<void>;
  notifyInviterProposal?: (
    invitationId: number,
    inviteeUser: User,
    formattedTime: string,
    eventTitle: string,
  ) => Promise<void>;
  birthdayService?: BirthdayService;
  userMemoryRepo?: import('../../database/repositories/user-memory.repository.ts').UserMemoryRepository;
  agentRegistry?: AgentRegistry;
  agentDispatcher?: AgentDispatcher;
  scenePauseService?: ScenePauseService;
  // Onboarding scene for mandatory timezone/language setup
  onboardingScene?: AnyScene;
}

// Steps that only accept button presses — text input on these steps routes to AI (Trigger 2).
// Step indices are owned by each scene and imported here to avoid duplication.
export const CALLBACK_ONLY_STEPS = new Map<string, Set<number>>([['add_event', CALLBACK_ONLY_STEP_INDICES]]);

function isCallbackOnlyStep(rawScene: unknown): boolean {
  try {
    const parsed = JSON.parse(rawScene as string) as { name?: string; step?: number };
    return CALLBACK_ONLY_STEPS.get(parsed.name ?? '')?.has(parsed.step ?? -1) ?? false;
  } catch {
    return false;
  }
}

// Full words/phrases for calendar-related keyword matching in groups.
// Uses word boundaries to avoid false positives (e.g., "планшет" ≠ "план").
const CALENDAR_KEYWORDS = [
  // RU — full words or long enough stems
  'событие',
  'события',
  'событий',
  'встреча',
  'встречу',
  'встречи',
  'встречаемся',
  'потусим',
  'потусить',
  'потусуем',
  'собираемся',
  'собираться',
  'планирую',
  'планируем',
  'запланируй',
  'запланировать',
  'напомни',
  'напоминание',
  'напомнить',
  'календарь',
  'календар',
  'расписание',
  'расписани',
  'когда',
  'во сколько',
  'перенеси',
  'перенести',
  'перенос',
  'отмени',
  'отменить',
  'отмена',
  'удали',
  'удалить',
  'завтра',
  'послезавтра',
  'сегодня',
  // EN — full words
  'event',
  'events',
  'meeting',
  'schedule',
  'scheduled',
  'reminder',
  'remind',
  'calendar',
  'appointment',
  'reschedule',
  'postpone',
  'tomorrow',
  'today',
];

const KEYWORD_PATTERN = new RegExp(`(?:^|\\s|[,.!?])(?:${CALENDAR_KEYWORDS.join('|')})(?:\\s|[,.!?]|$)`, 'i');

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

const ADDRESS_TARGETS = ['календарь', 'calendar'];
const ADDRESS_MAX_DISTANCE = 2;

// Exact "календарь"/"calendar" words are already in KEYWORD_PATTERN.
// This function handles typos only (e.g. "Каледарь,", "Calender,").
function startsWithCalendarAddress(text: string): boolean {
  const firstWord = (text.trim().split(/[\s,!.?:]+/)[0] ?? '').toLowerCase();
  if (firstWord.length < 5) return false;
  return ADDRESS_TARGETS.some((target) => levenshtein(firstWord, target) <= ADDRESS_MAX_DISTANCE);
}

function isGroupRelevant(text: string, botUsername: string): boolean {
  if (botUsername && text.includes(`@${botUsername}`)) return true;
  if (startsWithCalendarAddress(text)) return true;
  return KEYWORD_PATTERN.test(text);
}

const TG_API = 'https://api.telegram.org';

async function downloadTelegramFile(botToken: string, fileId: string): Promise<Buffer> {
  const metaRes = await fetch(`${TG_API}/bot${botToken}/getFile?file_id=${fileId}`);
  const meta = (await metaRes.json()) as { ok: boolean; result?: { file_path: string } };
  if (!meta.ok || !meta.result?.file_path) {
    throw new Error(`Failed to get file path from Telegram: ${JSON.stringify(meta)}`);
  }
  const fileRes = await fetch(`${TG_API}/file/bot${botToken}/${meta.result.file_path}`);
  if (!fileRes.ok) throw new Error(`Failed to download file: HTTP ${fileRes.status}`);
  return Buffer.from(await fileRes.arrayBuffer());
}

async function handleVoiceMessage(
  ctx: BotCommandContext,
  user: User,
  voice: { file_id: string; duration: number },
  deps: MessageHandlerDeps,
): Promise<void> {
  const chatId = ctx.chatId;
  if (!chatId) return;

  cmdLogger.info({ userId: user.telegram_id, duration: voice.duration }, 'Voice message received');

  const lang = user.language as 'en' | 'ru';

  try {
    const audioBuffer = await (deps.downloadVoiceBuffer ?? downloadTelegramFile)(deps.botToken!, voice.file_id);
    const transcription = await deps.transcriptionService!.transcribe(audioBuffer);

    if (!transcription) {
      await ctx.send(t(lang).voice_stt_error);
      return;
    }

    cmdLogger.info({ userId: user.telegram_id, transcription: transcription.slice(0, 100) }, 'Voice transcribed');

    const logChatId = Number(chatId) !== user.telegram_id ? Number(chatId) : undefined;
    deps.conversationLogger.logUserMessage(user.telegram_id, transcription, logChatId);

    const agentContext: AgentContext = {
      ...buildAgentContextFactory(deps)(user, Number(chatId), transcription),
      inputMode: 'voice_message',
    };

    const { responseText } = await deps.agent.run(agentContext);

    // Send voice reply if TTS is available and user has opted in
    if (responseText && user.voice_response_enabled === 1 && deps.sendVoice) {
      const isRu = user.language === 'ru';
      const hasPrimaryTts = isRu ? !!(deps.sileroTts && deps.stressDictionary) : !!deps.kokoroTts;
      if (hasPrimaryTts || deps.fallbackTts) {
        try {
          await fetch(`${TG_API}/bot${deps.botToken!}/sendChatAction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: Number(chatId), action: 'record_voice' }),
          }).catch(() => {});
          const plainText = stripMarkdown(responseText);
          const noLineBreaks = fixLineBreaks(plainText);
          let voiceBuffer: Buffer | undefined;
          try {
            if (isRu && deps.sileroTts && deps.stressDictionary) {
              const withOrdinals = fixDateOrdinals(noLineBreaks);
              const withNumbers = numbersToWords(withOrdinals);
              const withStress = markStress(withNumbers, deps.stressDictionary);
              const stressedText = transliterateEnglish(withStress);
              cmdLogger.info({ userId: user.telegram_id, textLen: stressedText.length }, 'Synthesizing RU voice reply');
              voiceBuffer = await deps.sileroTts.synthesize(stressedText);
            } else if (!isRu && deps.kokoroTts) {
              cmdLogger.info({ userId: user.telegram_id, textLen: noLineBreaks.length }, 'Synthesizing EN voice reply');
              voiceBuffer = await deps.kokoroTts.synthesize(noLineBreaks);
            }
          } catch (primaryError) {
            cmdLogger.warn({ err: primaryError, userId: user.telegram_id }, 'Primary TTS failed, trying fallback');
          }
          if (!voiceBuffer && deps.fallbackTts) {
            cmdLogger.info({ userId: user.telegram_id, lang: user.language }, 'Using fallback TTS');
            voiceBuffer = await deps.fallbackTts.synthesize(noLineBreaks, user.language ?? 'ru');
          }
          if (voiceBuffer) {
            await deps.sendVoice(Number(chatId), voiceBuffer);
          }
        } catch (ttsError) {
          cmdLogger.error({ err: ttsError, userId: user.telegram_id }, 'Voice reply TTS error');
        }
      }
    }

    // One-time opt-in prompt for users who have never been asked
    if (user.voice_response_enabled === null) {
      const keyboard = new InlineKeyboard()
        .text(t(lang).voice_prompt_yes, 'voice_prompt:yes')
        .text(t(lang).voice_prompt_no, 'voice_prompt:no');
      await ctx.send(t(lang).voice_prompt, { reply_markup: keyboard });
    }
  } catch (error) {
    cmdLogger.error({ err: error, userId: user.telegram_id }, 'Voice transcription error');
    await ctx.send(t(lang).voice_error);
  }
}

export function buildAgentContextFactory(deps: MessageHandlerDeps) {
  return (
    user: User,
    chatId: number,
    messageText: string,
    groupInfo?: {
      isGroup: boolean;
      groupChatId?: number;
      groupTitle?: string;
      onBotResponse?: (messageId: number) => void;
      incomingMessageId?: number;
    },
  ): AgentContext => {
    const activeFor = deps.secretaryRepo?.getActiveSecretaryFor(user.telegram_id) ?? [];
    const secretaryForLine =
      activeFor.length > 0
        ? activeFor
            .map((r) => {
              const owner = deps.userRepo.findByTelegramId(r.owner_id);
              const name = owner?.username ? `@${owner.username}` : `User ${r.owner_id}`;
              return `${name} (${r.permission === 'write' ? 'read+write' : 'read only'})`;
            })
            .join(', ')
        : undefined;

    return {
      user,
      chatId,
      messageText,
      incomingMessageId: groupInfo?.incomingMessageId,
      isGroup: groupInfo?.isGroup ?? false,
      groupChatId: groupInfo?.groupChatId,
      groupTitle: groupInfo?.groupTitle,
      onBotResponse: groupInfo?.onBotResponse,
      eventService: deps.eventService,
      holidayService: deps.holidayService,
      chatHistory: deps.chatHistory,
      conversationLogger: deps.conversationLogger,
      userRepo: deps.userRepo,
      reminderRepo: deps.reminderRepo,
      contactRepo: deps.contactRepo,
      participantRepo: deps.participantRepo,
      editProposalRepo: deps.editProposalRepo,
      secretaryRepo: deps.secretaryRepo,
      secretaryForLine,
      calendarProposalRepo: deps.calendarProposalRepo,
      checkGroupMembership: deps.checkGroupMembership,
      invitationService: deps.invitationService,
      invitationRepo: deps.invitationRepo,
      sharingService: deps.sharingService,
      sharingSettingsRepo: deps.sharingSettingsRepo,
      sharedEventRepo: deps.sharedEventRepo,
      privacyService: deps.privacyService,
      renderService: deps.renderService,
      notificationPrefs: deps.notificationPrefs,
      callQueue: deps.callQueue,
      callSettingsRepo: deps.callSettingsRepo,
      googleCalendarRepo: deps.googleCalendarRepo,
      deepLinkService: deps.deepLinkService,
      botUsername: deps.botUsername,
      stressDictionary: deps.stressDictionary,
      resolveUsername: deps.resolveUsername,
      groupChatRepo: deps.groupChatRepo,
      groupMemberRepo: deps.groupMemberRepo,
      groupMemberService: deps.groupMemberService,
      recentEventsWindow: groupInfo?.isGroup
        ? undefined
        : (() => {
            try {
              const now = new Date();
              const start = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
              const end = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
              return deps.eventService.getEventsInRange(user.telegram_id, start, end);
            } catch (err) {
              cmdLogger.error({ err, userId: user.telegram_id }, 'Failed to build schedule context');
              return [];
            }
          })(),
      birthdayService: deps.birthdayService,
      userMemoryRepo: deps.userMemoryRepo,
      agentRegistry: deps.agentRegistry,
      agentDispatcher: deps.agentDispatcher,
      sceneStorage: {
        delete: async (key: string) => {
          await deps.sceneStorage.delete(key);
        },
      },
    };
  };
}

export function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

const INTENT_EDIT_MAX_TOKENS = 2048;

const INTENT_EDIT_SYSTEM_PROMPT = `You are a JSON editor for calendar-bot intent objects.
Given a current intent JSON and admin instructions, return ONLY a valid JSON object with updated fields.
Only include fields that should change: phrases (string[]), trigger_words (string[]), pattern (string|null), workflow (object), format (string).
Do not include id, canonical_name, status, source_message, created_at.
IMPORTANT: Return raw JSON only — no markdown, no code fences, no backticks, no explanation.
Your response budget is ${INTENT_EDIT_MAX_TOKENS} tokens. Always emit complete, valid JSON — never truncate.

## Workflow syntax reference

Workflow is always { "steps": [...] }. Step types:
- Tool call: { "call": "tool_name", "input": {...} } — add "as": "var_name" to save output for later steps.
- Conditional: add "when": "expr" to any step — skip if false.
- Clarifying question: { "call": "ask_user", "input": { "question": "{{t.q}}", "options": ["{{t.opt1}}", "{{t.opt2}}"] }, "as": "name|lower" } — suspends, resumes when user replies. Answer is in ask.name namespace.
- Respond and stop: { "respond": "{{t.msg}}" }
- i18n: add "i18n": { "ru": { "key": "..." }, "en": { "key": "..." } } at workflow root when steps use {{t.key}}.

## Context helper functions (use in "when" expressions)
- isPastHour(h) — true if hour h (0-23) already passed today in user timezone
- isPastHourPM(h) — true if PM hour h (1-12, maps to h+12) already passed today
- isPastDay(d) — true if day-of-month d already passed this month
- isAmPmAmbiguous(h) — true if h is 1-12 (ambiguous AM/PM, must ask user)

## Template variables (ONLY these — any other {{var}} will crash at runtime)
Dates: {{dates.today}}, {{dates.yesterday}}, {{dates.tomorrow}}, {{dates.week_start}}, {{dates.week_end}}, {{dates.next_week_start}}, {{dates.next_week_end}}, {{dates.month_start}}, {{dates.month_end}}, {{dates.next_month_start}}, {{dates.now}}
User: {{user.id}}, {{user.username}}, {{user.first_name}}, {{user.timezone}}, {{user.language}}, {{user.utc_offset}}
Env: {{env.scope}} — "group" in group chats, "personal" in private chats
Captures: {{$1}}, {{$2}}, ... — regex capturing group values
Last events: {{last_added_event.id/.title/.date/.time/...}}, {{last_mentioned_event.id/.title/.date/.time/...}}
i18n text: {{t.key}}
Filters (pipe): {{$1|pad(2)}}, {{var|upper}}, {{var|lower}}, {{var|trim}}, {{var|truncate(50)}}, {{var|default("x")}}, {{var|replace("a","b")}}, {{var|date("dd.MM")}}, {{var|ternary("yes","no")}}, {{var|eq("m","if","else")}}, {{$1|add(12)}}

## AM/PM handling pattern
When hour $N could be 1-12, use ask_user for AM/PM clarification:
{ "steps": [
  { "when": "isAmPmAmbiguous($1) == false", "call": "create_event", "input": { "start_at": "{{dates.today}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}", "scope": "{{env.scope}}" } },
  { "when": "isAmPmAmbiguous($1)", "call": "ask_user", "input": { "question": "{{t.ampm_q}}", "options": ["{{t.am}}", "{{t.pm}}"] }, "as": "ampm|lower" },
  { "when": "isAmPmAmbiguous($1) && ask.ampm == 'am'", "call": "create_event", "input": { "start_at": "{{dates.today}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}", "scope": "{{env.scope}}" } },
  { "when": "isAmPmAmbiguous($1) && ask.ampm == 'pm'", "call": "create_event", "input": { "start_at": "{{dates.today}}T{{$1|add(12)|pad(2)}}:00:00{{user.utc_offset}}", "scope": "{{env.scope}}" } }
], "i18n": { "ru": { "ampm_q": "{{$1}}:00 — это утро или вечер?", "am": "утро", "pm": "вечер" }, "en": { "ampm_q": "Is {{$1}}:00 AM or PM?", "am": "AM", "pm": "PM" } } }

## Past-time handling pattern
When event is today and hour could be in the past, add isPastHour check:
{ "when": "isPastHour($1) == false", "call": "create_event", "input": { "start_at": "{{dates.today}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}", ... } },
{ "when": "isPastHour($1)", "call": "create_event", "input": { "start_at": "{{dates.tomorrow}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}", ... } }`;

async function handleIntentEditInstruction(
  ctx: BotCommandContext,
  instruction: string,
  session: AdminEditSession,
  deps: MessageHandlerDeps,
): Promise<void> {
  const intentRepo = deps.intentRepo;
  if (!intentRepo) {
    await ctx.send('Intent repository not configured.');
    return;
  }

  const intent = intentRepo.getById(session.intentId);
  if (!intent) {
    await ctx.send(`Intent #${session.intentId} not found.`);
    return;
  }

  const currentJson = JSON.stringify({
    phrases: JSON.parse(intent.phrases),
    trigger_words: JSON.parse(intent.trigger_words),
    pattern: intent.pattern,
    workflow: JSON.parse(intent.workflow),
    format: intent.format,
  });

  const MAX_RETRIES = 3;
  let updated: Partial<{
    phrases: string[];
    trigger_words: string[];
    pattern: string | null;
    workflow: { [key: string]: unknown };
    format: string;
  }> | null = null;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let rawText: string | undefined;
    try {
      const apiKey = deps.aiApiKey ?? '';
      const baseUrl = deps.aiBaseUrl ?? 'https://api.anthropic.com';

      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: deps.aiModel ?? 'glm-5',
          max_tokens: INTENT_EDIT_MAX_TOKENS,
          system: INTENT_EDIT_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: `Current intent:\n${currentJson}\n\nAdmin instructions: ${instruction}`,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`AI API error: ${response.status}`);
      }

      const data = (await response.json()) as { content: { type: string; text: string }[] };
      rawText = data.content.find((c) => c.type === 'text')?.text;
      if (!rawText) throw new Error('Empty AI response');

      const text = stripJsonFences(rawText);
      updated = JSON.parse(text) as Partial<{
        phrases: string[];
        trigger_words: string[];
        pattern: string | null;
        workflow: { [key: string]: unknown };
        format: string;
      }>;
      break;
    } catch (err) {
      lastError = err;
      cmdLogger.warn({ err, attempt, rawAiResponse: rawText }, 'Intent edit attempt failed, retrying');
    }
  }

  try {
    if (!updated) throw lastError;

    intentRepo.update(session.intentId, {
      ...(updated.phrases !== undefined && { phrases: JSON.stringify(updated.phrases) }),
      ...(updated.trigger_words !== undefined && { trigger_words: JSON.stringify(updated.trigger_words) }),
      ...(updated.pattern !== undefined && { pattern: updated.pattern }),
      ...(updated.workflow !== undefined && { workflow: JSON.stringify(updated.workflow) }),
      ...(updated.format !== undefined && { format: updated.format }),
    });

    const fresh = intentRepo.getById(session.intentId)!;
    const preview = [
      `✏️ Intent #${fresh.id} updated: <b>${fresh.canonical_name}</b>`,
      `Phrases: ${(JSON.parse(fresh.phrases) as string[]).map((p) => `"${p}"`).join(', ')}`,
      fresh.pattern ? `Pattern: ${fresh.pattern}` : 'Pattern: none',
      `Workflow: ${fresh.workflow}`,
      `Format: ${fresh.format}`,
    ].join('\n');

    const { InlineKeyboard } = await import('gramio');
    const kb = new InlineKeyboard()
      .text('✅ Accept', `intent_accept:${fresh.id}`)
      .text('✏️ Edit', `intent_edit:${fresh.id}`)
      .text('❌ Reject', `intent_reject:${fresh.id}`);

    await ctx.send(preview, { parse_mode: 'HTML', reply_markup: kb });
  } catch (error) {
    cmdLogger.error({ err: error }, 'Intent edit instruction failed');
    await ctx.send(`Failed to process edit: ${String(error)}`);
  }
}

async function handleProposeTimeInput(
  ctx: BotCommandContext,
  text: string,
  user: User,
  session: { invitationId: number },
  deps: MessageHandlerDeps,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const chatId = ctx.chatId;
  if (!chatId) return;

  const parsed = parseSimpleDate(text, user.timezone);

  if (!parsed) {
    deps.proposeTimeSessions?.set(user.telegram_id, session);
    await ctx.send(lang === 'ru' ? 'Не могу распознать время. Попробуй ещё раз:' : 'Could not parse time. Try again:');
    return;
  }

  const proposedTime = parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const result = deps.invitationService?.proposeTime(session.invitationId, user.telegram_id, proposedTime);

  if (!result?.success) {
    await ctx.send(result?.error ?? (lang === 'ru' ? 'Ошибка' : 'Error'));
    return;
  }

  const formattedTime = formatProposedTime(proposedTime, user.timezone, lang);
  await ctx.send(t(lang).invite_propose_sent(formattedTime), { parse_mode: 'HTML' });

  const invitation = deps.invitationRepo?.findById(session.invitationId);
  if (invitation?.message_id && invitation.chat_id && deps.editMessage) {
    deps
      .editMessage(invitation.chat_id, invitation.message_id, t(lang).invite_propose_sent(formattedTime))
      .catch((e: unknown) => {
        cmdLogger.error({ err: e }, 'Failed to edit invitation message after propose');
      });
  }

  if (deps.notifyInviterProposal) {
    const event = deps.eventService.getEvent?.(invitation?.event_id ?? 0, user.telegram_id);
    const eventTitle = (event as { title?: string } | undefined)?.title ?? '';
    deps.notifyInviterProposal(session.invitationId, user, formattedTime, eventTitle).catch((e: unknown) => {
      cmdLogger.error({ err: e }, 'Failed to notify inviter of time proposal');
    });
  }
}

export function toEventSummary(event: CalendarEvent, timezone: string): EventSummary {
  const d = new TZDate(new Date(event.start_at), timezone);
  const summary: EventSummary = {
    id: event.id,
    title: event.title,
    date: format(d, 'yyyy-MM-dd'),
    all_day: Boolean(event.all_day),
  };
  if (!event.all_day) summary.time = format(d, 'HH:mm');
  if (event.end_at) summary.end_at = event.end_at;
  if (event.description) summary.description = event.description;
  if (event.location) summary.location = event.location;
  if (event.recurrence_rule) summary.recurrence_rule = event.recurrence_rule;
  return summary;
}

const DURATION_TTL_MS = 5 * 60 * 1000;

export async function tryHandleDurationInput(
  ctx: BotCommandContext,
  userId: number,
  text: string,
  userRepo: UserRepository,
): Promise<boolean> {
  const ts = pendingDurationInput.get(userId);
  if (ts === undefined) return false;

  if (Date.now() - ts > DURATION_TTL_MS) {
    pendingDurationInput.delete(userId);
    return false;
  }

  const trimmed = text.trim();
  const mins = Number.parseInt(trimmed, 10);
  const valid = Number.isInteger(mins) && mins > 0 && mins <= 1440 && trimmed === String(mins);

  if (!valid) {
    await ctx.send('Введите число минут от 1 до 1440 (например: 45)');
    return true;
  }

  pendingDurationInput.delete(userId);
  userRepo.update(userId, { default_event_duration_minutes: mins });
  const label = mins >= 60 && mins % 60 === 0 ? `${mins / 60}ч` : `${mins} мин`;
  await ctx.send(`✅ Длительность встреч по умолчанию: ${label}`);
  return true;
}

const GROUP_TZ_TTL_MS = 5 * 60 * 1000;

export async function tryHandleGroupTzInput(
  ctx: BotCommandContext,
  userId: number,
  text: string,
  groupChatRepo: GroupChatRepository,
  aiModel?: string,
): Promise<boolean> {
  const entry = pendingGroupTzInput.get(userId);
  if (!entry) return false;

  if (Date.now() - entry.ts > GROUP_TZ_TTL_MS) {
    pendingGroupTzInput.delete(userId);
    return false;
  }

  const tz = await resolveCity(text.trim(), aiModel);
  pendingGroupTzInput.delete(userId);

  if (!tz) {
    await ctx.send(
      entry.lang === 'ru'
        ? 'Не удалось определить таймзону. Попробуйте ещё раз через /settings или введите код напрямую, например: Europe/Belgrade'
        : 'Could not determine timezone. Try again via /settings or enter the code directly, e.g. Europe/Belgrade',
    );
    return true;
  }

  groupChatRepo.setTimezone(entry.chatId, tz);
  await ctx.send(
    entry.lang === 'ru'
      ? `✅ Таймзона группы: ${getTimezoneDisplay(tz)}`
      : `✅ Group timezone: ${getTimezoneDisplay(tz)}`,
  );
  return true;
}

export function createMessageHandler(deps: MessageHandlerDeps) {
  const agentContextBuilder = buildAgentContextFactory(deps);
  const workflowSessions: WorkflowSessionStore =
    deps.workflowSessions ??
    (() => {
      const m = new Map<string, WorkflowSession>();
      const TTL = 5 * 60 * 1000;
      return {
        get: (chatId, userId) => {
          const s = m.get(`${chatId}:${userId}`);
          if (!s || Date.now() - s.createdAt >= TTL) {
            m.delete(`${chatId}:${userId}`);
            return null;
          }
          return s;
        },
        set: (chatId, userId, s) => m.set(`${chatId}:${userId}`, s),
        delete: (chatId, userId) => {
          m.delete(`${chatId}:${userId}`);
        },
        deleteByUser: (userId) => {
          for (const key of [...m.keys()]) {
            if (key.endsWith(`:${userId}`)) m.delete(key);
          }
        },
      };
    })();
  const eventMentionStore: EventMentionStore = deps.eventMentionStore ?? new InMemoryEventMentionStore();

  const aiAgentLayer = createAiAgentLayer({
    agent: deps.agent,
    agentContextBuilder: (user, chatId, messageText, groupInfo) => {
      const ctx = agentContextBuilder(user, chatId, messageText, groupInfo);
      ctx.onEventMentioned = (eventId) => {
        Promise.resolve(eventMentionStore.set(user.telegram_id, eventId)).catch((err: unknown) => {
          cmdLogger.error({ err: err, userId: user.telegram_id }, 'Failed to persist last mentioned event');
        });
      };
      return ctx;
    },
    intentLearner: deps.intentLearner,
    scenePauseService: deps.scenePauseService,
  });

  // Static layers that don't require per-message context
  const staticLayers = [...(deps.feedbackRepo ? [createFeedbackRouterLayer(deps.feedbackRepo)] : []), aiAgentLayer];

  const notifyAdmin =
    deps.botAdminId && deps.sendMessageToUser
      ? (text: string) => deps.sendMessageToUser!(deps.botAdminId!, text)
      : undefined;

  const getEventContext = async (userId: number, timezone: string) => {
    const lastAdded = deps.eventService.getLatestCreated(userId);
    const mentionedId = await eventMentionStore.get(userId);
    const lastMentioned = mentionedId ? deps.eventService.getEvent(mentionedId, userId) : null;
    return {
      lastAddedEvent: lastAdded ? toEventSummary(lastAdded, timezone) : undefined,
      lastMentionedEvent: lastMentioned ? toEventSummary(lastMentioned, timezone) : undefined,
    };
  };

  return async (ctx: BotCommandContext) => {
    const user = ctx.dbUser;
    if (!user) return;

    // Mandatory onboarding: redirect to setup if user hasn't completed it (private chats only)
    if (!user.onboarding_completed && deps.onboardingScene) {
      const isPrivate = ctx.chat.type === 'private';
      if (isPrivate) {
        // Check if a scene is already active (e.g. onboarding already in progress)
        const sceneKey = `@gramio/scenes:${user.telegram_id}`;
        const activeScene = await deps.sceneStorage.get(sceneKey);
        if (!activeScene) {
          await ctx.scene.enter(deps.onboardingScene);
        }
        return;
      }
    }

    // Voice message → transcribe → pass to AI agent
    const voice = ctx.voice;
    if (voice && deps.transcriptionService && deps.botToken) {
      return handleVoiceMessage(ctx, user, { file_id: voice.fileId, duration: voice.duration }, deps);
    }

    const text = ctx.text as string | undefined;
    if (!text) return;

    // Don't handle commands
    if (text.startsWith('/')) return;

    // Don't handle if a scene is active — @gramio/scenes handles those
    const sceneKey = `@gramio/scenes:${user.telegram_id}`;
    const activeScene = await deps.sceneStorage.get(sceneKey);
    if (activeScene) {
      const isPaused = deps.scenePauseService ? (await deps.scenePauseService.get(user.telegram_id)) !== null : false;

      if (!isPaused) {
        // Trigger 2: callback-only step — user typed instead of pressing a button → auto-pause
        if (deps.scenePauseService && isCallbackOnlyStep(activeScene)) {
          try {
            const parsed = JSON.parse(activeScene as string) as {
              name?: string;
              step?: number;
              state?: { [key: string]: unknown };
            };
            await deps.scenePauseService.save(user.telegram_id, {
              sceneName: parsed.name ?? 'unknown',
              step: parsed.step ?? 0,
              sceneState: parsed.state ?? {},
            });
          } catch {
            return; // can't parse scene state — skip
          }
          // fall through to AI pipeline
        } else {
          return;
        }
      }
    }

    const chatId = ctx.chatId;
    if (!chatId) return;

    // In groups: only respond to replies, mentions, or calendar keywords
    const chat = ctx.chat;
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    let isGroupSessionMessage = false;

    // Propose-time session: invitee typing a new time in response to an invite (private chats only)
    if (!isGroup && deps.proposeTimeSessions) {
      const proposeSession = deps.proposeTimeSessions.get(user.telegram_id);
      if (proposeSession) {
        deps.proposeTimeSessions.delete(user.telegram_id);
        return handleProposeTimeInput(ctx, text, user, proposeSession, deps);
      }
    }

    if (isGroup) {
      // Check pending group TZ input before relevance gate — the city name prompt
      // won't match any bot keyword, so it must be intercepted before the gate drops it
      if (deps.groupChatRepo) {
        const groupTzHandled = await tryHandleGroupTzInput(
          ctx,
          user.telegram_id,
          text,
          deps.groupChatRepo,
          deps.aiCityModel,
        );
        if (groupTzHandled) return;
      }

      const reply = ctx.replyMessage;
      const isReplyToBot = deps.botId !== undefined && reply?.from?.id === deps.botId;
      const botMention = deps.botUsername ? `@${deps.botUsername}` : '';

      // Track member for fallback reminders
      if (deps.groupMemberRepo) {
        deps.groupMemberRepo.upsert(Number(chatId), user.telegram_id);
      }

      if (deps.birthdayService) {
        deps.birthdayService
          .runBatchSync([
            {
              telegram_id: user.telegram_id,
              first_name: user.first_name,
              language: user.language,
              timezone: user.timezone,
            },
          ])
          .catch((err) => cmdLogger.error({ err, userId: user.telegram_id }, 'Birthday sync failed'));
      }

      const hasSession = deps.groupSessions?.hasActiveSession(Number(chatId)) ?? false;

      if (!isReplyToBot && !isGroupRelevant(text, botMention)) {
        if (!hasSession) return; // No trigger, no session — skip
        // Session active but no keyword — tick and keep typing indicator running
        deps.groupSessions!.tick(Number(chatId));
        isGroupSessionMessage = true;
      }
    }

    // Build context info for group messages
    const from = ctx.from;
    // GramIO's MessageContext exposes .id as the Telegram message_id via NodeMixinMetadata
    const incomingMsgId = ctx.id;
    let messagePrefix = '';
    if (isGroup && from) {
      const senderName = from.firstName ?? from.username ?? 'Unknown';
      const groupName = chat.title ?? 'group';
      const msgIdPart = incomingMsgId ? `, msg_id:${incomingMsgId}` : '';
      messagePrefix = `[Group: ${groupName}, From: ${senderName}${msgIdPart}] `;
    }

    const messageText = messagePrefix + text;

    // Admin reply session: if the admin has an active reply session, forward the message to the user
    if (
      deps.botAdminId &&
      user.telegram_id === deps.botAdminId &&
      deps.adminReplySession &&
      deps.feedbackRepo &&
      deps.sendMessageToUser
    ) {
      const session = deps.adminReplySession.get(user.telegram_id);
      if (session) {
        deps.adminReplySession.delete(user.telegram_id);
        const thread = deps.feedbackRepo.getThread(session.threadId);
        if (thread) {
          deps.feedbackRepo.addMessage({
            thread_id: session.threadId,
            sender: 'admin',
            text: messageText,
          });
          sendAdminReplyToUser(deps.sendMessageToUser, session.userId, messageText, thread.subject).catch(
            (e: unknown) => {
              cmdLogger.error({ err: e }, 'Failed to deliver admin reply to user');
            },
          );
          await ctx.send('Reply sent.');
        }
        return;
      }
    }

    // Admin intent edit session: if admin has an active edit session, process as edit instruction
    if (deps.botAdminId && user.telegram_id === deps.botAdminId && deps.adminEditSessions) {
      const editSession = deps.adminEditSessions.get(user.telegram_id);
      if (editSession) {
        deps.adminEditSessions.delete(user.telegram_id);
        if (isSessionExpired(editSession)) {
          await ctx.send('Edit session expired. Please click Edit again.');
          return;
        }
        await handleIntentEditInstruction(ctx, messageText, editSession, deps);
        return;
      }
    }

    const intentLayer =
      deps.intentMatcher && deps.intentRepo && deps.intentExecutor
        ? createIntentMatcherLayer(
            deps.intentMatcher,
            deps.intentRepo,
            deps.intentExecutor,
            (toolName, input) => {
              const agentCtx = agentContextBuilder(user, Number(ctx.chatId!), messageText, {
                isGroup,
                groupChatId: isGroup ? Number(chatId) : undefined,
                groupTitle: chat?.title ?? undefined,
              });
              // Inject sender so pick_users / ask_user / send_invitation work in intent context
              agentCtx.sender = deps.agent.getSender();
              // Track which events the intent touches
              agentCtx.onEventMentioned = (eventId) => {
                Promise.resolve(eventMentionStore.set(user.telegram_id, eventId)).catch((err: unknown) => {
                  cmdLogger.error({ err: err, userId: user.telegram_id }, 'Failed to persist last mentioned event');
                });
              };
              return executeTool(agentCtx, toolName, input);
            },
            workflowSessions,
            notifyAdmin,
            getEventContext,
            (uid, eventId) => {
              Promise.resolve(eventMentionStore.set(uid, eventId)).catch((err: unknown) => {
                cmdLogger.error({ err: err, userId: uid }, 'Failed to persist last mentioned event from intent');
              });
            },
            deps.conversationLogger,
          )
        : undefined;

    const layers = [...(intentLayer ? [intentLayer] : []), ...staticLayers];

    const groupContext = isGroup
      ? {
          isGroup: true as const,
          groupChatId: Number(chatId),
          groupTitle: chat?.title ?? undefined,
          incomingMessageId: incomingMsgId,
          onBotResponse: deps.groupSessions
            ? (messageId: number) => {
                if (deps.groupSessions!.hasActiveSession(Number(chatId))) {
                  deps.groupSessions!.refresh(Number(chatId), messageId);
                } else {
                  deps.groupSessions!.activate(Number(chatId), user.telegram_id, messageId);
                }
              }
            : undefined,
        }
      : undefined;

    if (!isGroup) {
      const durationHandled = await tryHandleDurationInput(ctx, user.telegram_id, text, deps.userRepo);
      if (durationHandled) return;
    }

    cmdLogger.info(
      { userId: user.telegram_id, chatId: Number(chatId), msgPreview: messageText.slice(0, 100) },
      '--- Message pipeline start ---',
    );

    if (isGroupSessionMessage && deps.botToken) {
      const sendTyping = () =>
        fetch(`${TG_API}/bot${deps.botToken}/sendChatAction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: Number(chatId), action: 'typing' }),
        }).catch((e: unknown) => cmdLogger.debug({ err: e }, 'sendChatAction typing failed'));
      sendTyping();
      const typingInterval = setInterval(sendTyping, 6000);
      try {
        await runPipeline(ctx, messageText, layers, groupContext);
      } finally {
        clearInterval(typingInterval);
      }
    } else {
      await runPipeline(ctx, messageText, layers, groupContext);
    }
  };
}

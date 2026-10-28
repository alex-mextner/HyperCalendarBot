// src/bot/handlers/message/voice-message.ts
// Voice message flow: download, transcription, and the agent turn over the transcript.

import { mkdir } from 'node:fs/promises';
import { InlineKeyboard } from 'gramio';
import { t } from '../../../config/constants.ts';
import type { User } from '../../../database/types.ts';
import type { AgentContext } from '../../../services/ai/types.ts';
import {
  fixDateOrdinals,
  fixLineBreaks,
  markStress,
  numbersToWords,
  stripMarkdown,
  transliterateEnglish,
} from '../../../services/voice/stress-marker.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import { escapeHtml } from '../../../utils/telegram.ts';
import type { BotCommandContext } from '../../types.ts';
import { buildAgentContextFactory } from './agent-context.ts';
import { downloadTelegramFile, TG_API } from './telegram-api.ts';
import type { MessageHandlerDeps } from './types.ts';

type VoiceReplyDeps = MessageHandlerDeps & {
  botToken: string;
  sendVoice: NonNullable<MessageHandlerDeps['sendVoice']>;
};

/** Whether any TTS backend (primary for the user's language, or the fallback) can voice a reply. */
function hasVoiceBackend(user: User, deps: MessageHandlerDeps): boolean {
  const hasPrimaryTts = user.language === 'ru' ? !!(deps.sileroTts && deps.stressDictionary) : !!deps.kokoroTts;
  return hasPrimaryTts || !!deps.fallbackTts;
}

/** Synthesize with the language's primary engine; a failure is logged and left to the fallback. */
async function synthesizePrimary(user: User, plainText: string, deps: MessageHandlerDeps): Promise<Buffer | undefined> {
  const isRu = user.language === 'ru';
  try {
    if (isRu && deps.sileroTts && deps.stressDictionary) {
      const withOrdinals = fixDateOrdinals(plainText);
      const withNumbers = numbersToWords(withOrdinals);
      const withStress = markStress(withNumbers, deps.stressDictionary);
      const stressedText = transliterateEnglish(withStress);
      cmdLogger.info({ userId: user.telegram_id, textLen: stressedText.length }, 'Synthesizing RU voice reply');
      return await deps.sileroTts.synthesize(stressedText);
    }
    if (!isRu && deps.kokoroTts) {
      cmdLogger.info({ userId: user.telegram_id, textLen: plainText.length }, 'Synthesizing EN voice reply');
      return await deps.kokoroTts.synthesize(plainText);
    }
  } catch (primaryError) {
    cmdLogger.warn({ err: primaryError, userId: user.telegram_id }, 'Primary TTS failed, trying fallback');
  }
  return undefined;
}

/** Send the agent's answer as a voice note when the user opted in and a TTS backend is available. */
async function sendVoiceReply(chatId: number, user: User, responseText: string, deps: VoiceReplyDeps): Promise<void> {
  if (!hasVoiceBackend(user, deps)) return;
  try {
    await fetch(`${TG_API}/bot${deps.botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'record_voice' }),
    }).catch(() => {});
    const noLineBreaks = fixLineBreaks(stripMarkdown(responseText));
    let voiceBuffer = await synthesizePrimary(user, noLineBreaks, deps);
    if (!voiceBuffer && deps.fallbackTts) {
      cmdLogger.info({ userId: user.telegram_id, lang: user.language }, 'Using fallback TTS');
      voiceBuffer = await deps.fallbackTts.synthesize(noLineBreaks, user.language ?? 'en');
    }
    if (voiceBuffer) {
      await deps.sendVoice(chatId, voiceBuffer);
    }
  } catch (ttsError) {
    cmdLogger.error({ err: ttsError, userId: user.telegram_id }, 'Voice reply TTS error');
  }
}

/** Persist a failure report under logs/voice-errors and forward it to the bot admin; never throws. */
function reportVoiceErrorToAdmin(
  error: unknown,
  user: User,
  voice: { duration: number },
  botToken: string,
  botAdminId: number,
): void {
  const errMsg = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `voice-error-${user.telegram_id}-${timestamp}.txt`;
  const report = [
    'Voice message processing error',
    `Date: ${new Date().toISOString()}`,
    `User: ${user.telegram_id} (@${user.username ?? '—'})`,
    `Duration: ${voice.duration ?? '?'}s`,
    '',
    errMsg,
  ].join('\n');

  const logDir = 'logs/voice-errors';
  void (async () => {
    await mkdir(logDir, { recursive: true });
    await Bun.write(`${logDir}/${filename}`, report);
    const form = new FormData();
    form.append('chat_id', String(botAdminId));
    form.append('document', new Blob([report], { type: 'text/plain' }), filename);
    form.append('caption', `🔴 Voice error: ${user.telegram_id} (@${user.username ?? '—'})`);
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: form,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      cmdLogger.error({ status: resp.status, body }, 'Failed to send voice error document to admin');
    }
  })().catch((e: unknown) => {
    cmdLogger.error({ err: e }, 'Failed to notify admin about voice error');
  });
}

export async function handleVoiceMessage(
  ctx: BotCommandContext,
  user: User,
  voice: { file_id: string; duration: number },
  deps: MessageHandlerDeps,
): Promise<void> {
  const chatId = ctx.chatId;
  if (!chatId || !deps.botToken) return;
  const botToken = deps.botToken;

  cmdLogger.info({ userId: user.telegram_id, duration: voice.duration }, 'Voice message received');

  const lang = user.language as 'en' | 'ru';

  try {
    const audioBuffer = await (deps.downloadVoiceBuffer ?? downloadTelegramFile)(botToken, voice.file_id);
    const transcription = await deps.transcriptionService!.transcribe(audioBuffer);

    if (!transcription) {
      await ctx.send(t(lang).voice_stt_error);
      return;
    }

    cmdLogger.info({ userId: user.telegram_id, transcription: transcription.slice(0, 100) }, 'Voice transcribed');

    // Show transcription to user as collapsed blockquote before AI response
    await ctx.send(`<blockquote expandable>🎤 <i>${escapeHtml(transcription)}</i></blockquote>`, {
      parse_mode: 'HTML',
    });

    const logChatId = Number(chatId) !== user.telegram_id ? Number(chatId) : undefined;
    const chatHistoryId = deps.conversationLogger.logUserMessage(user.telegram_id, transcription, logChatId);

    const agentContext: AgentContext = {
      ...buildAgentContextFactory(deps)(user, Number(chatId), transcription),
      inputMode: 'voice_message',
      incomingMessageId: ctx.id,
      chatHistoryId,
      voiceFileId: voice.file_id,
    };

    const { responseText } = await deps.agent.run(agentContext);

    // Send voice reply if TTS is available and user has opted in
    if (responseText && user.voice_response_enabled === 1 && deps.sendVoice) {
      await sendVoiceReply(Number(chatId), user, responseText, { ...deps, botToken, sendVoice: deps.sendVoice });
    }

    // One-time opt-in prompt for users who have never been asked
    if (user.voice_response_enabled === null) {
      const keyboard = new InlineKeyboard()
        .text(t(lang).voice_prompt_yes, 'voice_prompt:yes')
        .text(t(lang).voice_prompt_no, 'voice_prompt:no');
      await ctx.send(t(lang).voice_prompt, { reply_markup: keyboard });
    }
  } catch (error) {
    cmdLogger.error({ err: error, userId: user.telegram_id }, 'Voice message processing error');
    await ctx.send(t(lang).voice_error);
    if (deps.botAdminId) {
      reportVoiceErrorToAdmin(error, user, voice, botToken, deps.botAdminId);
    }
  }
}

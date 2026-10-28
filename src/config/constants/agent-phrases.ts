// src/config/constants/agent-phrases.ts
// Stall phrases and fallback-command hints shown when the AI agent is slow or unavailable.

// Phrase sets exported for testing (validate that error responses come from the declared set).
export const EN_AGENT_ERROR_PHRASES = [
  'One sec — rereading our chat. Be right back.',
  'Hold on — another bot stopped by for advice. With you in a moment.',
  'Oh no, where did I put my glasses...',
  'One sec — cat on keyboard. Moving them.',
  'Give me a moment — 1247 unread notifications to dig through.',
  'One sec, need to brew some coffee. Back in a moment.',
  "Be right back — another user called, telling them I'm busy.",
  'Hang on, checking my notes. Where did I write that down...',
  'One moment — ChatGPT dropped by again. Almost done.',
  'Hold on, one of my windows froze. Restarting.',
  "One sec — finding the right tab. I've got 847 open.",
  'Give me a moment — got a 15-page email, skimming it.',
] as const;

export const RU_AGENT_ERROR_PHRASES = [
  'Секундочку, перечитываю переписку, чуть позже отвечу.',
  'Минутку, ко мне другой бот пришёл за советом, сейчас помогу ему и отвечу!',
  'Ой, без очков не вижу, момент, куда я их подевал?..',
  'Подожди, тут кот запрыгнул на клавиатуру — убираю его.',
  'Секунду, у меня 1247 непрочитанных — пробираюсь сквозь них.',
  'Минутку, мне надо заварить себе кофе, и сразу отвечу.',
  'Одну секунду, звонит другой пользователь — скажу что занят и сразу к тебе.',
  'Подожди, смотрю в блокнот, куда же я это записал...',
  'Секунду, ChatGPT опять пришёл за советом. Сейчас отделаюсь.',
  'Момент, у меня тут зависло одно окно. Перезапускаю.',
  'Секундочку, ищу нужную вкладку. Их тут 847.',
  'Подожди немного, тут пришёл email на 15 страниц — надо быстро пробежать.',
] as const;

/**
 * Slash commands that keep working while the AI chain is down — they read the
 * database directly and never call a model. Shown whenever the bot has to admit
 * the smart part is unavailable. Kept to three so the whole notice fits a phone
 * notification preview.
 */
export const EN_AI_COMMANDS_HINT =
  "These still work:\n/today — today's schedule\n/add — create an event\n/help — all commands";
export const RU_AI_COMMANDS_HINT =
  'Пока работают команды:\n/today — расписание на сегодня\n/add — создать событие\n/help — все команды';

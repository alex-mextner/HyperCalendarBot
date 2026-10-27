// src/config/constants.ts
// Public entry point for shared constants and i18n messages; implementations live in ./constants/.

export {
  EN_AGENT_ERROR_PHRASES,
  EN_AI_COMMANDS_HINT,
  RU_AGENT_ERROR_PHRASES,
  RU_AI_COMMANDS_HINT,
} from './constants/agent-phrases.ts';
export { CB } from './constants/callback-data.ts';
export { DEFAULTS, RATE_LIMIT } from './constants/limits.ts';
export { type Lang, type Messages, MSG, t, toLang } from './constants/messages/index.ts';
export { maskPhone } from './constants/phone.ts';

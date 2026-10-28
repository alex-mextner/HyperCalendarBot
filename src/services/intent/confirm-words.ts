// Natural yes/no answers to a "Да / Отмена" confirmation. Only a two-option yes/cancel question is interpreted; every
// other answer keeps the old rule (it must equal an option). An answer that mixes both senses is never a yes.
import { normalize } from './normalizer.ts';

const AFFIRM = new Set([
  'да',
  'дa',
  'ага',
  'угу',
  'ок',
  'окей',
  'ok',
  'okay',
  'yes',
  'yep',
  'yeah',
  'sure',
  'давай',
  'конечно',
  'подтверждаю',
  'подтверди',
  'согласен',
  'согласна',
  'верно',
  'точно',
  'создавай',
  'создай',
  'удаляй',
  'удали',
  'делай',
  'go ahead',
  'confirm',
  'y',
  '+',
]);
const DECLINE = new Set([
  'нет',
  'неа',
  'не',
  'отмена',
  'отмени',
  'отменить',
  'cancel',
  'no',
  'nope',
  'стоп',
  'stop',
  'не надо',
  'не нужно',
  'не хочу',
  'не создавай',
  'не удаляй',
  'n',
  '-',
]);
const NEGATION = /(?:^|\s)(?:не|нет|no|not|dont|don't|cancel|отмена|отмени)(?:\s|$)/;
/** Words that may follow a yes without qualifying it ("да, пожалуйста"); anything else ("да но завтра") is not a yes. */
const POLITE = new Set(['пожалуйста', 'пж', 'please', 'thanks', 'спасибо', 'thx', 'plz']);

function isAffirmation(text: string): boolean {
  if (AFFIRM.has(text)) return true;
  const words = text.split(' ');
  return words.some((word) => AFFIRM.has(word)) && words.every((word) => AFFIRM.has(word) || POLITE.has(word));
}

/** The option a free-form answer stands for, or undefined when it is neither a clear yes nor a clear no. */
export function confirmationChoice(answer: string, options: readonly string[]): string | undefined {
  if (options.length !== 2) return undefined;
  const [yes, no] = options as [string, string];
  if (!AFFIRM.has(normalize(yes)) && normalize(yes) !== 'да') return undefined;
  // The second option must itself be a refusal ("Отмена", "Cancel"): "нет" must never select "Позже".
  if (!DECLINE.has(normalize(no))) return undefined;
  const text = normalize(answer);
  if (text === '') return undefined;
  if (DECLINE.has(text) || (NEGATION.test(text) && !AFFIRM.has(text))) return no;
  if (isAffirmation(text)) return yes;
  return undefined;
}

// src/bot/scenes/add-event-view.ts
// Add-event wizard presentation: per-step inline keyboard and the draft preview text.

import { InlineKeyboard } from 'gramio';
import { CB, type Lang, t } from '../../config/constants.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import type { AddEventState } from './types.ts';

export function wizardKeyboard(step: number, lang: Lang, number?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  const wizardText = t(lang).addWizard;
  if (step === 1) kb.text(wizardText.today, 'add:date:today').text(wizardText.tomorrow, 'add:date:tomorrow').row();
  if (step === 2)
    kb.text(wizardText.duration30, 'add:duration:30')
      .text(wizardText.duration60, 'add:duration:60')
      .text(wizardText.duration120, 'add:duration:120')
      .row();
  if (step === 3) {
    kb.text(wizardText.none, `${CB.ADD_RECURRENCE}:none`).row();
    for (const freq of ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const)
      kb.text(wizardText.frequencies[freq], `${CB.ADD_RECURRENCE}:${freq}`).row();
  }
  if (step === 4) {
    if (number)
      kb.text(wizardText.untilChoice(number), `${CB.ADD_REC_END}:until:${number}`)
        .text(wizardText.countChoice(number), `${CB.ADD_REC_END}:count:${number}`)
        .row();
    kb.text(wizardText.noEnd, `${CB.ADD_REC_END}:forever`)
      .text(wizardText.untilDate, `${CB.ADD_REC_END}:until`)
      .text(wizardText.repeatCount, `${CB.ADD_REC_END}:count`)
      .row();
  }
  if ([2, 5, 6].includes(step)) kb.text(t(lang).skip, `${CB.ADD_SKIP}:${step}`).row();
  if (step === 7) kb.text(wizardText.confirm, 'add:confirm').row();
  if (step > 0) kb.text(wizardText.back, `add:back:${step}`);
  return kb.text(wizardText.cancel, CB.ADD_CANCEL);
}

export function draftPreview(state: AddEventState, lang: Lang, timezone: string): string {
  const wizardText = t(lang).addWizard;
  const local = (value: string) =>
    new Intl.DateTimeFormat(lang, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    );
  const field = (value: string | undefined, limit: number) =>
    escapeHtml(value ? value.slice(0, limit) + (value.length > limit ? '…' : '') : wizardText.none);
  const lines = [
    `<b>${wizardText.preview}</b>`,
    `${wizardText.title}: ${field(state.title, 300)}`,
    `${wizardText.date}: ${state.startAt ? local(state.startAt) : '—'} (${escapeHtml(timezone)})`,
  ];
  if (state.endAt) lines.push(`${wizardText.end}: ${local(state.endAt)}`);
  let repeat: string = wizardText.none;
  const freq = /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.exec(state.recurrenceRule ?? '')?.[1];
  if (freq === 'DAILY' || freq === 'WEEKLY' || freq === 'MONTHLY' || freq === 'YEARLY') {
    repeat = wizardText.frequencies[freq];
    const interval = /INTERVAL=(\d+)/.exec(state.recurrenceRule ?? '')?.[1];
    const count = /COUNT=(\d+)/.exec(state.recurrenceRule ?? '')?.[1];
    const until = /UNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(state.recurrenceRule ?? '');
    if (interval) repeat += ` · ${wizardText.interval(Number(interval))}`;
    if (count) repeat += ` · ${wizardText.count(Number(count))}`;
    if (until)
      repeat += ` · ${wizardText.until(local(`${until[1]}-${until[2]}-${until[3]}T${until[4]}:${until[5]}:${until[6]}Z`))}`;
  }
  lines.push(
    `${wizardText.repeat}: ${repeat}`,
    `${wizardText.description}: ${field(state.description, 1300)}`,
    `${wizardText.location}: ${field(state.location, 500)}`,
    '',
    wizardText.previewHint,
  );
  return lines.join('\n');
}

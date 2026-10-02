import type { BotCommandContext } from '../../bot/types.ts';
import { IntentLearningError } from './context.ts';
import type { IntentLearningService } from './service.ts';

export function learningCommand(service: IntentLearningService, adminId: number | undefined) {
  return async (ctx: BotCommandContext): Promise<void> => {
    if (!adminId || ctx.dbUser?.telegram_id !== adminId || Number(ctx.chatId) !== adminId) {
      await ctx.send('Управление обучением доступно только администратору в личном чате.');
      return;
    }
    const text = ctx.text ?? '';
    const [command, arg, hash] = text.trim().split(/\s+/);
    try {
      if (command?.startsWith('/intent_approve')) {
        if (!/^[1-9]\d*$/.test(arg ?? '') || !/^[a-f0-9]{16,64}$/.test(hash ?? '')) {
          await ctx.send('Формат: /intent_approve ID HASH — значения из предложения.');
          return;
        }
        const result = service.approve({
          proposalId: Number(arg),
          expectedHash: hash!,
          actor: { kind: 'telegram', userId: adminId },
        });
        await ctx.send(`Решение применено: ${JSON.stringify(result)}`);
        return;
      }
      if (command?.startsWith('/intent_reject')) {
        if (!/^[1-9]\d*$/.test(arg ?? '')) {
          await ctx.send('Формат: /intent_reject ID');
          return;
        }
        service.reject({ proposalId: Number(arg), actor: { kind: 'telegram', userId: adminId } });
        await ctx.send('Предложение отклонено. Действующие правила не менялись.');
        return;
      }
      if (command?.startsWith('/intent_review') && /^[1-9]\d*$/.test(arg ?? '')) {
        const proposal = service.getProposal(Number(arg));
        await ctx.send(proposal ? JSON.stringify(proposal, null, 2).slice(0, 3800) : 'Предложение не найдено.');
        return;
      }
      const status = service.status();
      const waiting = status.awaitingAdmin
        .map(
          (p) =>
            `#${p.id}: ${p.summary}\n/intent_review ${p.id}\n/intent_approve ${p.id} ${p.hash.slice(0, 16)}\n/intent_reject ${p.id}`,
        )
        .join('\n\n');
      await ctx.send(
        `Обучение: серверная очередь → Opus 5 auto → независимая проверка → ваше одобрение.\nЗадания: ${status.jobs.map((j) => `${j.status}: ${j.count}`).join(', ') || 'нет'}\nЛимиты: ${status.rate.limits.startsPerHour}/час, ${status.rate.limits.startsPerDay}/день.\n\n${waiting || 'Готовых предложений пока нет.'}`.slice(
          0,
          4000,
        ),
      );
    } catch (error) {
      await ctx.send(
        error instanceof IntentLearningError
          ? `Изменение не применено: ${error.code}. Откройте актуальное предложение.`
          : 'Не удалось обработать предложение. Действие не повторено автоматически.',
      );
    }
  };
}

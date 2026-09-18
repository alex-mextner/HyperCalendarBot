/** Deterministic source SSG, never opens a database or imports the mutating seeder. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { auditDefinition } from '../src/services/intent/catalog-audit.ts';
import { IntentMatcher } from '../src/services/intent/intent-matcher.ts';
import { seedIntents } from '../src/services/intent/seed-catalog.ts';
import { candidateTaskLabels } from './intent-task-labels.ts';

const Candidate = z.object({
  canonical_name: z.string().regex(/^[a-z][a-z0-9_]+$/),
  pattern: z.string().nullable(),
  workflow: z.record(z.string(), z.unknown()),
  phrases: z.array(z.string()),
  trigger_words: z.array(z.string()),
  source_message: z.string(),
  origin: z.string(),
  format: z.string().optional(),
});
const recover = z.object({ sourcePullRequest: z.literal(205), definitions: z.array(Candidate) });
const labels: Record<string, string> = {
  show_today: 'Расписание сегодня',
  show_tomorrow: 'Расписание завтра',
  show_week: 'Расписание недели',
  free_slots_today: 'Свободное время сегодня',
  search_events_by_query: 'Поиск по словам',
  create_event_named_tomorrow: 'Создать завтра с подтверждением',
};
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: unknown) => String(value ?? '—').replace(/[&<>"']/g, (c) => ESC[c]!);
const markdown = (value: unknown) =>
  escapeHtml(value)
    .replace(/[[\]()`|*]/g, (c) => `&#${c.charCodeAt(0)};`)
    .replace(/\r?\n/g, '<br>');

export function buildCatalogue(
  source: unknown = JSON.parse(readFileSync(new URL('./intent-candidates.json', import.meta.url), 'utf8')),
) {
  const recovered = recover.parse(source);
  const definitions = [
    ...seedIntents.map((s) => ({
      ...s,
      origin: 'active' as const,
      format: 'text',
      source: 'src/services/intent/seed-catalog.ts',
    })),
    ...recovered.definitions.map((s) => ({ ...s, origin: 'candidate' as const, source: s.origin })),
  ];
  const keys = new Set<string>();
  for (const definition of definitions) {
    if (keys.has(definition.canonical_name)) throw new Error(`Duplicate intent key: ${definition.canonical_name}`);
    keys.add(definition.canonical_name);
  }
  const matcher = new IntentMatcher();
  matcher.load(
    definitions.map((s, i) => ({
      id: i + 1,
      canonical_name: s.canonical_name,
      phrases: JSON.stringify(s.phrases),
      trigger_words: JSON.stringify(s.trigger_words),
      pattern: s.pattern,
      workflow: JSON.stringify(s.workflow),
      format: s.format ?? 'text',
      status: 'approved' as const,
      source_message: null,
      created_at: '',
    })),
  );
  const entries = definitions.map((s, i) => {
    const examples = [...new Set([...s.phrases, s.source_message])];
    const audit = auditDefinition(s);
    const matching = examples.map((phrase) => {
      const d = matcher.explain(phrase);
      return {
        example: phrase,
        result: d.kind === 'matched' ? (d.result.intentId === i + 1 ? 'own' : 'different') : d.reason,
      };
    });
    const issues = [
      ...(!audit.schemaValid ? ['schema'] : []),
      ...(audit.contractErrors ? ['tool_contract'] : []),
      ...(matching.some((x) => x.result === 'ambiguous') ? ['ambiguous'] : []),
      ...(matching.some((x) => !['own', 'ambiguous'].includes(x.result)) ? ['matching'] : []),
    ];
    return {
      name: s.canonical_name,
      title: labels[s.canonical_name] ?? candidateTaskLabels[s.canonical_name] ?? s.canonical_name.replaceAll('_', ' '),
      origin: s.origin,
      source: s.source,
      deployed: null,
      examples,
      pattern: s.pattern,
      tools: audit.tools,
      issues,
      audit,
      matching,
    };
  });
  const fingerprint = createHash('sha256').update(JSON.stringify(definitions)).digest('hex');
  return { schemaVersion: 1, fingerprint, entries };
}
type Catalogue = ReturnType<typeof buildCatalogue>;
const methods = `## Способы сопоставления

1. **Точные фразы:** индекс псевдонимов ищет кандидата; параметризованная фраза всё равно обязана извлечь аргументы. Коллизия двух разных правил — отказ от автоматического выбора.
2. **Индексированные шаблоны:** триггеры выбирают кандидатов, регулярное выражение должно покрыть всё сообщение. Аргументы сохраняют исходные регистр, пунктуацию, время и username; нормализация используется только для поиска.
3. **Неоднозначность и контекст:** несовпавший или неоднозначный запрос передаётся планировщику/уточнению. Порядок загрузки правил не даёт права выбирать запись или адресата.
4. **Следующий этап #130:** сравнить типизированные шаблоны, морфологический/лексический и embedding-поиск кандидатов, NLI и Light/Medium/Smart на размеченном отложенном корпусе. Семантическая близость — не разрешение выполнять запись. Эта часть пока не реализована данным генератором.

Матчинг не заменяет проверку прав, конкретного инструмента, ссылки на событие и подтверждения. Текущие JS-regex ещё требуют отдельного ограничения вычислений; эта страница не объявляет закрытым ReDoS-аудит.
`;
export function renderMarkdown(c: Catalogue): string {
  const active = c.entries.filter((x) => x.origin === 'active').length;
  const rows = c.entries
    .map(
      (e) =>
        `| [${e.name}](#${e.name}) | ${e.origin === 'active' ? 'в текущем сиде' : 'кандидат PR205'} | ${e.issues.length ? e.issues.join(', ') : 'ограниченные проверки пройдены'} | ${e.tools.join(', ')} |`,
    )
    .join('\n');
  const details = c.entries
    .map(
      (e) =>
        `### ${e.name}\n\n**${markdown(e.title)}.** ${e.origin === 'active' ? 'Поставляется текущим сидом.' : 'Восстановленный кандидат, не включён в runtime-сид.'}\n\nИнструменты: ${e.tools.map((x) => `\`${x}\``).join(', ') || 'ответ без инструмента'}. Диагностика: **${e.issues.join(', ') || 'ограниченные проверки пройдены; не E2E-приёмка'}**.\n\nПримеры: ${e.examples.map((x) => markdown(x)).join(' · ')}\n\nШаблон:\n\n\`\`\`text\n${e.pattern ?? '(только точные фразы)'}\n\`\`\`\n\nИсточник: ${e.origin === 'active' ? '[активный сид](../../src/services/intent/seed-catalog.ts)' : '[полное определение workflow](../../scripts/intent-candidates.json)'}; исходный файл \`${e.source}\`.\n`,
    )
    .join('\n');
  return `<!-- Generated by bun run docs:intents; do not edit. -->\n# Интенты: текущий сид и полный восстановленный каталог\n\n**${c.entries.length} уникальных сценария: ${active} в активном сиде, ${c.entries.length - active} кандидатов из [PR205](https://github.com/alex-mextner/HyperCalendarBot/pull/205).** Это не ${c.entries.length} установленных и одобренных правил.\n\n[Статическая HTML-страница](index.html) · [машинная диагностика](catalogue.json) · [полный план](../plans/2026-09-18-intent-redesign.md)\n\nСодержимое генерируется из исходников, а не вручную скопированного отчёта. Fingerprint: \`${c.fingerprint}\`.\n\n**Статистика БД не включена** в публичный SSG. Полный приватный снимок и сравнение с историей строятся отдельно через [read-only audit](../intent-catalogue.md). Отсутствие статистики — не ноль.\n\n\`\`\`bash\nbun run docs:intents\nbun run docs:intents:check\n\`\`\`\n\n\`README.md\` читается непосредственно в GitHub; \`index.html\` — готовая offline-страница для статического хостинга. Обновление сида требует перегенерации: тест сравнивает актуальные исходники со всеми тремя артефактами.\n\n${methods}\n## Пример привязки аргумента\n\n\`\`\`json\n{"call":"search_events","input":{"query":"{{$1}}"}}\n\`\`\`\n\n## Все сценарии\n\n| Ключ | Источник | Текущая диагностика | Инструменты |\n|---|---|---|---|\n${rows}\n\n## Определения\n\n${details}`;
}
export function renderHtml(c: Catalogue): string {
  const active = c.entries.filter((e) => e.origin === 'active').length;
  const scopeOptions = [
    ['all', `Все ${c.entries.length}`],
    ['active', 'Текущий сид'],
    ['candidate', 'Кандидаты расширения'],
  ]
    .map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`)
    .join('');
  const cards = c.entries
    .map(
      (e) =>
        `<article id="${e.name}" data-kind="${e.origin}" data-search="${escapeHtml([e.name, e.title, ...e.tools, ...e.examples].join(' ').toLowerCase())}"><span class="badge ${e.issues.length ? 'warn' : ''}">${e.origin === 'active' ? 'В текущем сиде' : 'Кандидат PR205'}</span><h2>${escapeHtml(e.title)}</h2><code>${e.name}</code><p class="tools">${escapeHtml(e.tools.join(' · ') || 'Ответ без инструмента')}</p><p>${e.issues.length ? `Нужна доработка: <strong>${escapeHtml(e.issues.join(', '))}</strong>` : 'Ограниченные проверки пройдены — это не подтверждение безопасного исполнения.'}</p><details><summary>Примеры и шаблон</summary><ul>${e.examples.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul><pre>${escapeHtml(e.pattern ?? 'Только точные фразы')}</pre><p>Исходный файл: ${escapeHtml(e.source)}</p></details></article>`,
    )
    .join('\n');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HyperCalendar — полный каталог интентов</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f5fa;color:#211c34;font:16px/1.55 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:32px 22px}h1{font-size:clamp(30px,5vw,52px);line-height:1.12;max-width:860px}.brand{font-weight:750;color:#7042c5}p.lead{max-width:860px;color:#625772}aside{background:#eee7fa;padding:20px;border-radius:14px;margin:24px 0}.metrics{display:flex;gap:18px;flex-wrap:wrap}.metric{flex:1;min-width:180px;background:white;padding:20px;border-radius:14px}.metric b{display:block;font-size:38px}nav{display:flex;gap:14px;margin:26px 0}input,select{font:inherit;border:1px solid #d5cce5;border-radius:10px;padding:12px}input{flex:1;min-width:0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}article{background:white;border:1px solid #e2dcef;border-radius:15px;padding:22px;min-width:0}h2{font-size:21px;overflow-wrap:anywhere}code,.tools,pre{overflow-wrap:anywhere;word-break:break-word}pre{white-space:pre-wrap;font-size:12px;background:#f6f5fa;padding:12px}code{font-size:12px}.badge{font-size:12px;background:#eaf5ef;color:#235540;border-radius:6px;padding:5px 8px}.warn{background:#fff1d2;color:#765013}summary{cursor:pointer}a{color:#7042c5}.hidden{display:none}footer{padding:32px 0;font-size:12px;color:#6f667c;overflow-wrap:anywhere}@media(max-width:650px){.grid{grid-template-columns:1fr}nav{flex-direction:column}.metric{min-width:140px}}
</style></head><body><main><p class="brand">HC · HyperCalendar · source SSG</p><h1>Сценарии и способы сопоставления</h1><p class="lead">Текущий исполняемый сид и ${c.entries.length} авторских сценария из начатой работы разделены явно. Наличие определения не означает, что оно установлено, протестировано на всех переписках или безопасно для автоматической записи.</p><div class="metrics"><div class="metric"><b>${c.entries.length}</b>сценариев в каталоге</div><div class="metric"><b>${active}</b>предустановок в текущем сиде</div><div class="metric"><b>${c.entries.length - active}</b>кандидатов из 12 категорий</div></div><aside><strong>Не выдаём кандидатов за готовый продукт.</strong> Схема, инструменты, извлечение параметров и пересечения проверяются отдельно. Production-статистика не публикуется; приватный аудит доступен владельцу. <a href="README.md">Описание метчинга и все определения в GitHub</a>.</aside><nav><input id="search" aria-label="Поиск сценария" placeholder="Сценарий, пример или инструмент…"><select id="scope" aria-label="Источник">${scopeOptions}</select></nav><p id="count" aria-live="polite"></p><section class="grid">${cards}</section><footer>Сгенерировано из seed-catalog.ts и intent-candidates.json · ${c.fingerprint}<br>Обновление: bun run docs:intents · Проверка: bun run docs:intents:check · Личных сообщений и идентификаторов Telegram здесь нет.</footer></main><script>const search=document.getElementById('search'),scope=document.getElementById('scope');function filter(){const q=search.value.toLowerCase().trim();let n=0;document.querySelectorAll('article[data-kind]').forEach(e=>{const show=(scope.value==='all'||e.dataset.kind===scope.value)&&e.dataset.search.includes(q);e.classList.toggle('hidden',!show);if(show)n++});document.getElementById('count').textContent='Показано: '+n}search.addEventListener('input',filter);scope.addEventListener('change',filter);filter();</script></body></html>\n`;
}
export function generatedFiles() {
  const c = buildCatalogue();
  return {
    'README.md': renderMarkdown(c),
    'index.html': renderHtml(c),
    'catalogue.json': `${JSON.stringify(c, null, 2)}\n`,
  };
}
export function checkGeneratedFiles(directory: string): void {
  for (const [name, data] of Object.entries(generatedFiles())) {
    if (readFileSync(resolve(directory, name), 'utf8') !== data)
      throw new Error(`Generated docs stale: ${name}; run bun run docs:intents`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((x) => x !== '--check')) throw new Error('Usage: bun run docs:intents [--check]');
  const directory = resolve(import.meta.dir, '../docs/intents');
  if (args.includes('--check')) {
    checkGeneratedFiles(directory);
    console.log('Intent SSG is current');
  } else {
    mkdirSync(directory, { recursive: true });
    for (const [name, data] of Object.entries(generatedFiles())) writeFileSync(resolve(directory, name), data);
    console.log('Generated docs/intents: Markdown, HTML, JSON');
  }
}

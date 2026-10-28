/**
 * HTML output of the intent documentation: the single offline page (index.html) with engine description,
 * searchable rule cards and lineage. Styles and scripts live in sibling files so the page stays readable.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Marked } from 'marked';
import { ASSET_BANNER, HTML_ASSET_FILES, HTML_SCRIPT, HTML_STYLES } from './intent-doc-assets.ts';
import {
  type Catalogue,
  type CatalogueEntry,
  DISPOSITIONS,
  type Disposition,
  DOCS_DIRECTORY,
  LINEAGE_FILE,
  tally,
} from './intent-doc-catalogue.ts';
import { categoryTitles, dispositionTitles, riskTitles } from './intent-doc-labels.ts';
import { CORPUS_NOTE, lineageSummary, pageOf, planRulePages, ruleFiles } from './intent-doc-markdown.ts';
import {
  categoryTitle,
  checkSummary,
  describeBinding,
  describeStep,
  escapeHtml,
  groupByCategory,
  htmlOf,
  riskTitle,
  viewOf,
} from './intent-doc-text.ts';

export function readEngineMarkdown(): string {
  return readFileSync(resolve(DOCS_DIRECTORY, 'engine.md'), 'utf8');
}

/** Engine text for the page: headings drop one level under the page title and wide tables scroll inside a wrapper. */
function renderEngineHtml(markdown: string): string {
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const level = Math.min(depth + 1, 6);
        return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
      table(token) {
        const head = token.header
          .map((cell) => `<th scope="col">${this.parser.parseInline(cell.tokens)}</th>`)
          .join('');
        const rows = token.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${this.parser.parseInline(cell.tokens)}</td>`).join('')}</tr>`)
          .join('');
        return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  return marked.parse(markdown, { async: false });
}

function renderBindingTypesHtml(c: Catalogue): string {
  const usage = tally(c.entries.flatMap((entry) => entry.bindingTypes));
  const rows = c.engine.bindingTypes
    .map(
      (b) =>
        `<tr><td><code>${escapeHtml(b.type)}</code></td><td>${escapeHtml(b.title)}</td><td>${usage[b.type] ?? 0}</td></tr>`,
    )
    .join('');
  return `<h3>Типы привязок в исходном коде и число правил, где они используются</h3><div class="scroll"><table><thead><tr><th scope="col">Тип</th><th scope="col">Что читает</th><th scope="col">Правил с этим типом</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function listHtml(items: readonly string[], tag: 'ul' | 'ol' = 'ul'): string {
  return `<${tag}>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
}

function renderCardDetails(entry: CatalogueEntry, page: string): string {
  const view = viewOf(entry.workflow);
  const steps = view.steps.map((step) => `<li>${htmlOf(describeStep(step, view.ru))}</li>`).join('');
  const bindings = view.bindings
    .map(([name, binding]) => `<li>${htmlOf(describeBinding(name, binding))}</li>`)
    .join('');
  const predecessors = entry.predecessors
    .map(
      (p) =>
        `<li><code>${escapeHtml(p.key)}</code> (${escapeHtml(p.title)}; ${escapeHtml(dispositionTitles[p.disposition]!.toLowerCase())})</li>`,
    )
    .join('');
  return [
    `<h4>Примеры фраз</h4>${listHtml(entry.examples)}`,
    entry.negativeExamples.length ? `<h4>Уходят к AI</h4>${listHtml(entry.negativeExamples)}` : '',
    entry.invalidInputExamples.length
      ? `<h4>Привязка отвергает до вызова инструментов</h4>${listHtml(entry.invalidInputExamples)}`
      : '',
    `<h4>Шаги</h4><ol>${steps}</ol>`,
    bindings ? `<h4>Привязки</h4><ul>${bindings}</ul>` : '',
    predecessors ? `<h4>Заменяет прежние правила</h4><ul>${predecessors}</ul>` : '',
    `<h4>Проверка при сборке</h4><p>${escapeHtml(checkSummary(entry))}</p>`,
    `<details><summary>Регулярное выражение и полный workflow (JSON)</summary><pre>${escapeHtml(entry.pattern)}</pre><pre data-workflow="${escapeHtml(entry.name)}">Без JavaScript workflow не подставляется: полный текст лежит <a href="${escapeHtml(page)}#${escapeHtml(entry.name)}">на странице правила</a>.</pre></details>`,
  ].join('');
}

function searchText(entry: CatalogueEntry): string {
  return [
    entry.name,
    entry.title,
    categoryTitle(entry.category),
    riskTitle(entry.risk),
    ...entry.tools,
    ...entry.examples,
    ...entry.predecessors.flatMap((p) => [p.key, p.title]),
  ]
    .join(' ')
    .toLowerCase();
}

function renderCard(entry: CatalogueEntry, page: string): string {
  const note = entry.notes
    ? `<p><small>Пометка из исходника (по-английски): ${escapeHtml(entry.notes)}</small></p>`
    : '';
  return `<article id="${escapeHtml(entry.name)}" data-name="${escapeHtml(entry.name)}" data-category="${escapeHtml(entry.category)}" data-risk="${escapeHtml(entry.risk)}" data-search="${escapeHtml(searchText(entry))}"><h3>${escapeHtml(entry.title)}</h3><ul class="chips"><li class="chip">${escapeHtml(categoryTitle(entry.category))}</li><li class="chip ${escapeHtml(entry.risk)}">${escapeHtml(riskTitle(entry.risk))}</li>${entry.issues.length ? `<li class="chip warn">Требует внимания: ${escapeHtml(entry.issues.join(', '))}</li>` : ''}</ul><p><code>${escapeHtml(entry.name)}</code></p><p>Инструменты: ${escapeHtml(entry.tools.join(', ') || 'нет, ответ без инструмента')}</p>${note}<details><summary>Подробности: примеры, шаги, привязки, JSON</summary>${renderCardDetails(entry, page)}</details></article>`;
}

function optionsHtml(counts: { [key: string]: number }, title: (key: string) => string, order: string[]): string {
  const keys = Object.keys(counts).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return keys
    .map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(title(key))} (${counts[key]})</option>`)
    .join('');
}

function renderFilters(c: Catalogue): string {
  const categories = optionsHtml(tally(c.entries.map((e) => e.category)), categoryTitle, Object.keys(categoryTitles));
  const risks = optionsHtml(tally(c.entries.map((e) => e.risk)), riskTitle, Object.keys(riskTitles));
  return `<form class="filters" role="search" aria-label="Поиск и фильтры правил" onsubmit="return false"><label for="search">Поиск по названию, фразе или инструменту<input id="search" type="search" autocomplete="off" placeholder="Например: удалить, контакт, get_events"></label><label for="category">Категория<select id="category"><option value="">Все категории</option>${categories}</select></label><label for="risk">Уровень риска<select id="risk"><option value="">Все уровни</option>${risks}</select></label></form>`;
}

function renderLineageTableHtml(c: Catalogue): string {
  const titles = new Map(c.entries.map((entry) => [entry.name, entry.title]));
  const rank = (d: Disposition) => DISPOSITIONS.indexOf(d);
  const rows = [...c.lineage.source.entries]
    .sort((a, b) => rank(a.disposition) - rank(b.disposition) || a.oldKey.localeCompare(b.oldKey))
    .map((e) => {
      const target = e.target
        ? `<a href="#${escapeHtml(e.target)}">${escapeHtml(titles.get(e.target) ?? e.target)}</a>`
        : 'нет замены';
      return `<tr><td><code>${escapeHtml(e.oldKey)}</code></td><td>${escapeHtml(e.oldTitle)}</td><td>${escapeHtml(dispositionTitles[e.disposition])}</td><td>${target}</td><td>${escapeHtml(e.reason)}</td></tr>`;
    })
    .join('');
  return `<div class="scroll"><table><caption class="sr">Прежние правила из исходников и их судьба</caption><thead><tr><th scope="col">Прежний ключ</th><th scope="col">Прежний заголовок</th><th scope="col">Что стало</th><th scope="col">Новое правило</th><th scope="col">Причина (текст из исходника, по-английски)</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderDatabaseCohortHtml(c: Catalogue): string {
  const db = c.lineage.database;
  if (!db.provided)
    return `<h3>Когорта живой базы (учитывается отдельно)</h3><p>Санитизированный список правил из живой базы для этой сборки не предоставлен (<code>${LINEAGE_FILE}</code> отсутствует). Сравнения с базой здесь нет.</p>`;
  const rows = db.entries
    .map(
      (e) =>
        `<tr><td>${e.id}</td><td><code>${escapeHtml(e.oldKey)}</code></td><td>${escapeHtml(e.status)}</td><td>${escapeHtml(dispositionTitles[e.disposition])}</td><td>${e.target ? `<code>${escapeHtml(e.target)}</code>` : 'нет замены'}</td><td>${escapeHtml(e.previousTools.join(', ') || '—')}</td><td>${escapeHtml(e.reason)}</td></tr>`,
    )
    .join('');
  return `<h3>Когорта живой базы (учитывается отдельно)</h3><p>Правил, найденных в живой базе: <b>${db.total}</b> (слито ${db.merge}, переписано ${db.rewrite}, выведено ${db.retire}). Это другая группа, а не добавка к ${c.lineage.source.total} прежним правилам из исходников: числа не складываются. Записи содержат только обобщённый смысл, без текста сообщений и без идентификаторов пользователей.</p><details><summary>Таблица живой базы (${db.total})</summary><div class="scroll"><table><thead><tr><th scope="col">Номер</th><th scope="col">Прежний ключ</th><th scope="col">Статус</th><th scope="col">Что стало</th><th scope="col">Новое правило</th><th scope="col">Прежние инструменты</th><th scope="col">Причина</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function renderLineageHtml(c: Catalogue): string {
  const s = c.lineage.source;
  return `<section id="lineage" aria-labelledby="lineage-title"><h2 id="lineage-title">Происхождение: от прежних правил к единому сиду</h2><p>${escapeHtml(lineageSummary(c).replaceAll('**', ''))}</p><details><summary>Все прежние правила из исходников (${s.total})</summary>${renderLineageTableHtml(c)}</details>${renderDatabaseCohortHtml(c)}</section>`;
}

function renderMetrics(c: Catalogue): string {
  const s = c.lineage.source;
  const db = c.lineage.database;
  const metric = (value: number | string, label: string) => `<li><b>${value}</b>${escapeHtml(label)}</li>`;
  return `<ul class="metrics" aria-label="Сводка">${[
    metric(c.entries.length, 'правил в целевом сиде'),
    metric(new Set(c.entries.map((e) => e.category)).size, 'категорий'),
    metric(s.total, 'прежних правил из исходников'),
    metric(`${s.merge} / ${s.rewrite} / ${s.retire}`, 'слито / переписано / выведено'),
    metric(db.provided ? db.total : '—', 'прежних записей БД, отдельная группа'),
  ].join('')}</ul>`;
}

function renderHeader(c: Catalogue): string {
  return `<p class="brand">HyperCalendar</p><h1>Правила интентов: единый сид и движок</h1><p class="lead">Целевой набор из ${c.entries.length} правил, собранный из исходного кода. Правило распознаёт фразу, проверяет параметры и вызывает те же инструменты календаря, что доступны AI.</p><aside class="notice" role="note"><strong>Это целевой сид, а не отчёт о развёртывании.</strong> Страница строится из исходников и не видит базу. Установку подтверждает отдельная проверка живой базы: отпечаток <code>${c.fingerprint}</code> должен совпасть со значением в <code>intent_basis_manifest</code>. Ссылки: <a href="README.md">каталог для GitHub</a>, <a href="engine.md">описание движка</a>, <a href="catalogue.json">машиночитаемый каталог</a>, <a href="../intent-catalogue.md">заметки по приватному отчёту</a>.</aside>${renderMetrics(c)}<nav class="jump" aria-label="Разделы страницы"><a href="#engine">Движок</a><a href="#catalogue">Каталог правил</a><a href="#lineage">Происхождение</a></nav>`;
}

/** JSON for a classic script: `<` and the two line separators are written as escapes so `<!--` can never comment out a row. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replace(/[<\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** One compact workflow per rule; index.js pretty-prints it into the card, matching the JSON on the rule pages. */
function renderWorkflowData(c: Catalogue): string {
  const rows = c.entries.map((entry) => `  ${scriptJson(entry.name)}: ${scriptJson(entry.workflow)}`);
  return `${ASSET_BANNER}\nwindow.INTENT_WORKFLOWS = {\n${rows.join(',\n')}\n};\n`;
}

function renderHead(): string {
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HyperCalendar: правила интентов и движок</title><link rel="stylesheet" href="${HTML_ASSET_FILES.styles}">`;
}

export function renderHtml(c: Catalogue, engine: string = readEngineMarkdown()): string {
  const files = ruleFiles(planRulePages(c));
  const cards = groupByCategory(c.entries)
    .flatMap((group) => group.entries)
    .map((entry) => renderCard(entry, pageOf(files, entry.name)))
    .join('\n');
  const total = c.entries.length;
  return `<!doctype html><html lang="ru"><head>${renderHead()}</head><body><a class="skip" href="#catalogue">Перейти к каталогу</a><main>${renderHeader(c)}<section id="engine" aria-label="Описание движка">${renderEngineHtml(engine)}${renderBindingTypesHtml(c)}</section><section id="catalogue" aria-labelledby="catalogue-title"><h2 id="catalogue-title">Каталог правил</h2>${renderFilters(c)}<p id="count" role="status" aria-live="polite">Показано: ${total} из ${total}</p><p id="empty" hidden>Ничего не найдено. Измени запрос или сбрось фильтры.</p><div class="grid">${cards}</div></section>${renderLineageHtml(c)}<footer>Отпечаток целевого сида: <code>${c.fingerprint}</code><br>Пересборка: <code>bun run docs:intents</code>; проверка: <code>bun run docs:intents:check</code>. ${escapeHtml(CORPUS_NOTE)} Идентификаторов Telegram и текста переписок здесь нет.</footer></main><script src="${HTML_ASSET_FILES.workflows}"></script><script src="${HTML_ASSET_FILES.script}"></script></body></html>\n`;
}

/** index.css, index.js and the workflow data the page script renders into every card. */
export function renderHtmlAssets(c: Catalogue): { [file: string]: string } {
  return {
    [HTML_ASSET_FILES.styles]: `${ASSET_BANNER}${HTML_STYLES}`,
    [HTML_ASSET_FILES.script]: `${ASSET_BANNER}${HTML_SCRIPT}`,
    [HTML_ASSET_FILES.workflows]: renderWorkflowData(c),
  };
}

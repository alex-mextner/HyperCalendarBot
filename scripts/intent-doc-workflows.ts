/** Readable workflow pages preserve the original pretty HTML blocks, including their entity spelling. */
import type { Catalogue, CatalogueEntry } from './intent-doc-catalogue.ts';
import { planRulePages, RULES_DIRECTORY, type RulePage } from './intent-doc-markdown.ts';
import { escapeHtml } from './intent-doc-text.ts';

export const WORKFLOWS_DIRECTORY = 'workflows';

/** This is the complete workflow block emitted by the original single-page renderer. */
export const renderWorkflowBlock = (entry: CatalogueEntry): string =>
  `<pre>${escapeHtml(JSON.stringify(entry.workflow, null, 2))}</pre>`;

const workflowPage = (page: RulePage): string =>
  `${WORKFLOWS_DIRECTORY}/${page.file.slice(RULES_DIRECTORY.length + 1).replace(/\.md$/, '.html')}`;

const pageTitle = (page: RulePage): string =>
  page.parts > 1 ? `${page.title} (${page.part}/${page.parts})` : page.title;

export function workflowFiles(c: Catalogue): Map<string, string> {
  return new Map(
    planRulePages(c).flatMap((page) => page.cards.map(({ entry }) => [entry.name, workflowPage(page)] as const)),
  );
}

function navigation(pages: readonly RulePage[], index: number): string {
  const previous = pages[index - 1];
  const next = pages[index + 1];
  const link = (page: RulePage, label: string): string =>
    `<a href="${escapeHtml(workflowPage(page).slice(WORKFLOWS_DIRECTORY.length + 1))}">${label}: ${escapeHtml(pageTitle(page))}</a>`;
  return `<nav aria-label="Workflow pages">${[
    previous ? link(previous, 'Previous') : '',
    '<a href="../index.html#catalogue">Catalogue</a>',
    next ? link(next, 'Next') : '',
  ]
    .filter(Boolean)
    .join(' · ')}</nav>`;
}

function renderWorkflowPage(pages: readonly RulePage[], index: number): string {
  const page = pages[index]!;
  const blocks = page.cards.map(
    ({ entry }) =>
      `<section id="${escapeHtml(entry.name)}"><h2>${escapeHtml(entry.title)}</h2><p><code>${escapeHtml(entry.name)}</code> · <a href="../index.html#${escapeHtml(entry.name)}">Back to rule</a></p>\n${renderWorkflowBlock(entry)}\n</section>`,
  );
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(pageTitle(page))} — HyperCalendar workflows</title><link rel="stylesheet" href="../index.css"></head><body><main>
${navigation(pages, index)}
<h1>${escapeHtml(pageTitle(page))}</h1>
${blocks.join('\n')}
${navigation(pages, index)}
</main></body></html>
`;
}

/** Each emitted page is checked independently by the unchanged generated-file line ceiling. */
export function renderWorkflowPages(c: Catalogue): { [file: string]: string } {
  const pages = planRulePages(c);
  return Object.fromEntries(pages.map((page, index) => [workflowPage(page), renderWorkflowPage(pages, index)]));
}

import { marked } from 'marked';
import { escapeHtml } from './helpers.ts';
import { sharedCSS } from './shared-css.ts';
import type { MdTableData, TemplateRenderer } from './types.ts';

function css(theme: MdTableData['theme']): string {
  return `
    ${sharedCSS({ bg: theme.bg, textPrimary: theme.textPrimary })}
    .tbl-title {
      font-size: 28px;
      font-weight: 700;
      color: ${theme.textPrimary};
      margin-bottom: 24px;
      line-height: 1.3;
    }
    .tbl-wrap {
      background: ${theme.cardBg};
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 18px;
    }
    th {
      background: ${theme.accent};
      color: #fff;
      font-weight: 600;
      padding: 14px 20px;
      text-align: left;
    }
    td {
      padding: 12px 20px;
      color: ${theme.textPrimary};
      border-bottom: 1px solid ${theme.border};
    }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) td { background: ${theme.bg}; }
    .tbl-caption {
      margin-top: 16px;
      font-size: 14px;
      color: ${theme.textSecondary};
      opacity: 0.8;
    }
    .footer {
      margin-top: 32px;
      text-align: right;
      font-size: 14px;
      color: ${theme.textSecondary};
      opacity: 0.6;
    }
  `;
}

function render(data: MdTableData): string {
  const tableHtml = marked.parse(data.markdown, { async: false }) as string;
  const captionBlock = data.caption ? `<div class="tbl-caption">${escapeHtml(data.caption)}</div>` : '';
  const styles = css(data.theme);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>${styles}</style>
</head>
<body>
<div id="__root">
  <div class="tbl-title">${escapeHtml(data.title)}</div>
  <div class="tbl-wrap">${tableHtml}</div>
  ${captionBlock}
  <div class="footer">HyperCalendar</div>
</div>
</body>
</html>`;
}

export const mdTableTemplate: TemplateRenderer<MdTableData> = { render };

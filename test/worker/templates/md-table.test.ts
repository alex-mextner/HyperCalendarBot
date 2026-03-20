import { describe, expect, test } from 'bun:test';
import { mdTableTemplate } from '../../../src/worker/templates/md-table.ts';
import { getTheme } from '../../../src/worker/templates/themes.ts';

const theme = getTheme();

describe('mdTableTemplate', () => {
  test('renders title in output', () => {
    const html = mdTableTemplate.render({
      title: 'Сравнение тарифов',
      markdown: '| Plan | Price |\n|---|---|\n| Basic | $5 |',
      theme,
    });
    expect(html).toContain('Сравнение тарифов');
  });

  test('renders table HTML from markdown', () => {
    const html = mdTableTemplate.render({
      title: 'Test',
      markdown: '| A | B |\n|---|---|\n| 1 | 2 |',
      theme,
    });
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
  });

  test('renders optional caption', () => {
    const html = mdTableTemplate.render({
      title: 'Test',
      markdown: '| A |\n|---|\n| 1 |',
      caption: 'Данные актуальны на март 2026',
      theme,
    });
    expect(html).toContain('Данные актуальны на март 2026');
  });

  test('no caption block when caption omitted', () => {
    const html = mdTableTemplate.render({
      title: 'Test',
      markdown: '| A |\n|---|\n| 1 |',
      theme,
    });
    expect(html).not.toContain('class="tbl-caption"');
  });

  test('escapes title XSS', () => {
    const html = mdTableTemplate.render({
      title: '<script>alert(1)</script>',
      markdown: '| A |\n|---|\n| 1 |',
      theme,
    });
    expect(html).not.toContain('<script>');
  });

  test('output contains __root div', () => {
    const html = mdTableTemplate.render({
      title: 'Test',
      markdown: '| A |\n|---|\n| 1 |',
      theme,
    });
    expect(html).toContain('id="__root"');
  });
});

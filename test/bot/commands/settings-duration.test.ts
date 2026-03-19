import { expect, test } from 'bun:test';
import { buildDurationView, buildGeneralText } from '../../../src/bot/commands/settings.ts';

test('buildGeneralText shows default duration', () => {
  const text = buildGeneralText('UTC', 'ru', 'RU', 45);
  expect(text).toContain('45 мин');
});

test('buildDurationView shows current duration', () => {
  const { text, kb } = buildDurationView(30);
  expect(text).toContain('30 мин');
  expect(JSON.stringify(kb)).toContain('stg:set_duration:15');
  expect(JSON.stringify(kb)).toContain('stg:set_duration:30');
  expect(JSON.stringify(kb)).toContain('stg:set_duration:60');
});

test('buildDurationView marks active duration with checkmark', () => {
  const { kb } = buildDurationView(60);
  expect(JSON.stringify(kb)).toContain('✅');
});

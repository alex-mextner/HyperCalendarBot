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

test('buildGeneralText formats 90 min as "90 мин", not "1.5ч"', () => {
  const text = buildGeneralText('UTC', 'ru', 'RU', 90);
  expect(text).toContain('90 мин');
  expect(text).not.toContain('1.5ч');
});

test('buildDurationView formats 90 min as "90 мин", not "1.5ч"', () => {
  const { text } = buildDurationView(90);
  expect(text).toContain('90 мин');
  expect(text).not.toContain('1.5ч');
});

test('buildGeneralText formats 120 min as "2ч"', () => {
  const text = buildGeneralText('UTC', 'ru', 'RU', 120);
  expect(text).toContain('2ч');
});

test('buildDurationView formats 120 min as "2ч"', () => {
  const { text } = buildDurationView(120);
  expect(text).toContain('2ч');
});

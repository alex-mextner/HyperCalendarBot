import { expect, test } from 'bun:test';
import { buildDurationView, buildGeneralText } from '../../../src/bot/commands/settings.ts';

test('buildGeneralText shows default duration', () => {
  const text = buildGeneralText('UTC', 'ru', 'RU', 45);
  expect(text).toContain('45 мин');
});

test('buildGeneralText EN shows English strings', () => {
  const text = buildGeneralText('UTC', 'en', 'US', 60);
  expect(text).toContain('General settings');
  expect(text).toContain('Timezone');
  expect(text).toContain('1h');
});

test('buildDurationView shows current duration (ru)', () => {
  const { text, kb } = buildDurationView(30, 'ru');
  expect(text).toContain('30 мин');
  expect(JSON.stringify(kb)).toContain('stg:set_duration:15');
  expect(JSON.stringify(kb)).toContain('stg:set_duration:30');
  expect(JSON.stringify(kb)).toContain('stg:set_duration:60');
});

test('buildDurationView shows current duration (en)', () => {
  const { text } = buildDurationView(30, 'en');
  expect(text).toContain('30 min');
  expect(text).toContain('Default event duration');
});

test('buildDurationView marks active duration with checkmark', () => {
  const { kb } = buildDurationView(60, 'ru');
  expect(JSON.stringify(kb)).toContain('✅');
});

test('buildGeneralText formats 90 min as "90 мин", not "1.5ч"', () => {
  const text = buildGeneralText('UTC', 'ru', 'RU', 90);
  expect(text).toContain('90 мин');
  expect(text).not.toContain('1.5ч');
});

test('buildDurationView formats 90 min as "90 мин", not "1.5ч"', () => {
  const { text } = buildDurationView(90, 'ru');
  expect(text).toContain('90 мин');
  expect(text).not.toContain('1.5ч');
});

test('buildGeneralText formats 120 min as "2ч"', () => {
  const text = buildGeneralText('UTC', 'ru', 'RU', 120);
  expect(text).toContain('2ч');
});

test('buildDurationView formats 120 min as "2ч"', () => {
  const { text } = buildDurationView(120, 'ru');
  expect(text).toContain('2ч');
});

test('buildDurationView EN formats 120 min as "2h"', () => {
  const { text } = buildDurationView(120, 'en');
  expect(text).toContain('2h');
});

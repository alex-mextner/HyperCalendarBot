import { expect, test } from 'bun:test';
import { formatBirthdayLine } from '../../../src/bot/commands/birthdays.ts';

test('RU: uses tg link when celebrant_id known, strips Д/р prefix', () => {
  const line = formatBirthdayLine({
    title: 'Д/р Иван',
    celebrantId: 12345,
    birthYear: 1996,
    username: null,
    eventDate: new Date('2026-05-10T00:00:00Z'),
    lang: 'ru',
  });
  expect(line).toContain('<a href="tg://user?id=12345">Иван</a>');
  expect(line).toContain('30 лет');
  expect(line).not.toContain('Д/р');
  expect(line).toContain('🎁');
});

test('RU: age 31 uses correct plural "год"', () => {
  const line = formatBirthdayLine({
    title: 'Д/р Иван',
    celebrantId: 12345,
    birthYear: 1995,
    username: null,
    eventDate: new Date('2026-05-10T00:00:00Z'),
    lang: 'ru',
  });
  expect(line).toContain('31 год');
});

test('RU: age 22 uses correct plural "года"', () => {
  const line = formatBirthdayLine({
    title: 'Д/р Иван',
    celebrantId: 12345,
    birthYear: 2004,
    username: null,
    eventDate: new Date('2026-05-10T00:00:00Z'),
    lang: 'ru',
  });
  expect(line).toContain('22 года');
});

test('RU: uses @username when no celebrant_id', () => {
  const line = formatBirthdayLine({
    title: 'Д/р Маша',
    celebrantId: null,
    birthYear: null,
    username: 'masha_k',
    eventDate: new Date('2026-06-22T00:00:00Z'),
    lang: 'ru',
  });
  expect(line).toContain('@masha_k');
  expect(line).toContain('Маша');
  expect(line).not.toContain('Д/р');
});

test('EN: strips Bday prefix, uses tg link', () => {
  const line = formatBirthdayLine({
    title: 'Bday Ivan',
    celebrantId: 42,
    birthYear: 2001,
    username: null,
    eventDate: new Date('2026-05-10T00:00:00Z'),
    lang: 'en',
  });
  expect(line).toContain('<a href="tg://user?id=42">Ivan</a>');
  expect(line).toContain('turns 25');
  expect(line).not.toContain('Bday');
});

test('plain name when no id or username', () => {
  const line = formatBirthdayLine({
    title: 'Bday Pete',
    celebrantId: null,
    birthYear: null,
    username: null,
    eventDate: new Date('2026-09-07T00:00:00Z'),
    lang: 'en',
  });
  expect(line).toContain('Pete');
  expect(line).not.toContain('Bday');
  expect(line).toContain('🎁');
});

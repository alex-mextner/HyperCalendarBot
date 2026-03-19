import { expect, test } from 'bun:test';
import { classifyInterrupt } from '../../../src/services/voice/interruption-classifier.ts';

test('noise: empty string', () => {
  expect(classifyInterrupt('')).toBe('noise');
});

test('noise: single non-filler word', () => {
  expect(classifyInterrupt('хм')).toBe('noise');
});

test('resume: single filler "да"', () => {
  expect(classifyInterrupt('да')).toBe('resume');
});

test('resume: single filler "угу"', () => {
  expect(classifyInterrupt('угу')).toBe('resume');
});

test('resume: two fillers "ага ок"', () => {
  expect(classifyInterrupt('ага ок')).toBe('resume');
});

test('resume: english filler "yeah"', () => {
  expect(classifyInterrupt('yeah')).toBe('resume');
});

test('respond: command with multiple words', () => {
  expect(classifyInterrupt('добавь встречу завтра')).toBe('respond');
});

test('respond: question', () => {
  expect(classifyInterrupt('что у меня сегодня')).toBe('respond');
});

test('respond: mixed filler + real word makes it respond', () => {
  expect(classifyInterrupt('да встречу')).toBe('respond');
});

test('respond: three single-word fillers → respond (3 words)', () => {
  expect(classifyInterrupt('да нет ок')).toBe('respond');
});

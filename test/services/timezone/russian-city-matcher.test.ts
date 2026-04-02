// test/services/timezone/russian-city-matcher.test.ts
import { describe, expect, test } from 'bun:test';
import { matchCity, stemRussian } from '../../../src/services/timezone/russian-city-matcher.ts';

describe('stemRussian', () => {
  test('strips prepositional case endings', () => {
    expect(stemRussian('москве')).toBe('москв');
    expect(stemRussian('новгороде')).toBe('новгород');
    expect(stemRussian('нижнем')).toBe('нижн');
  });

  test('strips genitive case endings', () => {
    expect(stemRussian('москвы')).toBe('москв');
    expect(stemRussian('новгорода')).toBe('новгород');
    expect(stemRussian('нижнего')).toBe('нижн');
  });

  test('strips instrumental case endings', () => {
    expect(stemRussian('москвой')).toBe('москв');
    expect(stemRussian('новгородом')).toBe('новгород');
    expect(stemRussian('нижним')).toBe('нижн');
  });

  test('strips nominative adjective endings', () => {
    expect(stemRussian('нижний')).toBe('нижн');
    expect(stemRussian('верхний')).toBe('верхн');
    expect(stemRussian('великий')).toBe('велик');
  });

  test('keeps short words unchanged', () => {
    expect(stemRussian('мск')).toBe('мск');
    expect(stemRussian('спб')).toBe('спб');
  });

  test('handles multi-word input', () => {
    expect(stemRussian('нижнем новгороде')).toBe('нижн новгород');
    expect(stemRussian('нижний новгород')).toBe('нижн новгород');
    expect(stemRussian('санкт-петербурге')).toBe('санкт-петербург');
  });
});

describe('matchCity', () => {
  test('exact nominative match', () => {
    expect(matchCity('москва')).toBe('Europe/Moscow');
    expect(matchCity('нижний новгород')).toBe('Europe/Moscow');
  });

  test('prepositional case (в ...)', () => {
    expect(matchCity('москве')).toBe('Europe/Moscow');
    expect(matchCity('нижнем новгороде')).toBe('Europe/Moscow');
    expect(matchCity('петербурге')).toBe('Europe/Moscow');
    expect(matchCity('лондоне')).toBe('Europe/London');
  });

  test('genitive case (из ...)', () => {
    expect(matchCity('москвы')).toBe('Europe/Moscow');
  });

  test('case insensitive', () => {
    expect(matchCity('Москве')).toBe('Europe/Moscow');
    expect(matchCity('ЛОНДОНЕ')).toBe('Europe/London');
  });

  test('abbreviations', () => {
    expect(matchCity('мск')).toBe('Europe/Moscow');
    expect(matchCity('спб')).toBe('Europe/Moscow');
    expect(matchCity('екб')).toBe('Asia/Yekaterinburg');
  });

  test('fuzzy match — typos and minor misspellings', () => {
    expect(matchCity('маями')).toBe('America/New_York');
    expect(matchCity('майами')).toBe('America/New_York');
  });

  test('handles question marks and punctuation', () => {
    expect(matchCity('москве?')).toBe('Europe/Moscow');
    expect(matchCity('лондоне!')).toBe('Europe/London');
  });

  test('returns null for unknown city', () => {
    expect(matchCity('абракадабра')).toBeNull();
    expect(matchCity('xyzxyz')).toBeNull();
  });

  test('handles world cities in Russian', () => {
    expect(matchCity('токио')).toBe('Asia/Tokyo');
    expect(matchCity('париже')).toBe('Europe/Paris');
    expect(matchCity('берлине')).toBe('Europe/Berlin');
    expect(matchCity('дубае')).toBe('Asia/Dubai');
  });

  test('handles cities with different timezones', () => {
    expect(matchCity('владивостоке')).toBe('Asia/Vladivostok');
    expect(matchCity('новосибирске')).toBe('Asia/Novosibirsk');
    expect(matchCity('екатеринбурге')).toBe('Asia/Yekaterinburg');
    expect(matchCity('самаре')).toBe('Europe/Samara');
    expect(matchCity('красноярске')).toBe('Asia/Krasnoyarsk');
  });
});

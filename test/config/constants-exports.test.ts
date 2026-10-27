import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as constants from '../../src/config/constants.ts';
import {
  EN_AGENT_ERROR_PHRASES,
  EN_AI_COMMANDS_HINT,
  MSG,
  RU_AGENT_ERROR_PHRASES,
  RU_AI_COMMANDS_HINT,
  t,
  toLang,
} from '../../src/config/constants.ts';
import { formatTempCurrent, formatTempRange } from '../../src/services/weather/format.ts';

const CONSTANTS_DIR = resolve(import.meta.dir, '../../src/config/constants');
const MESSAGES_DIR = join(CONSTANTS_DIR, 'messages');

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Recursive key paths; arrays are leaves because their indices are content, not structure. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

/** Every `messages/<lang>/*.ts` topic module; each exports one `as const` table. */
async function topicTables(lang: 'en' | 'ru'): Promise<Record<string, object>[]> {
  const files = listTsFiles(join(MESSAGES_DIR, lang)).sort();
  return Promise.all(
    files.map(async (file) => {
      // The specifier is discovered from the directory listing, so it cannot be a static import.
      const mod: Record<string, object> = await import(file);
      return mod;
    }),
  );
}

describe('config/constants public surface', () => {
  test('keeps exactly the runtime exports importers rely on', () => {
    expect(Object.keys(constants).sort()).toEqual([
      'CB',
      'DEFAULTS',
      'EN_AGENT_ERROR_PHRASES',
      'EN_AI_COMMANDS_HINT',
      'MSG',
      'RATE_LIMIT',
      'RU_AGENT_ERROR_PHRASES',
      'RU_AI_COMMANDS_HINT',
      'maskPhone',
      't',
      'toLang',
    ]);
  });

  test('t() returns the table of the requested language', () => {
    expect(t('en')).toBe(MSG.en);
    expect(t('ru')).toBe(MSG.ru);
    expect(t(toLang('ru-RU'))).toBe(MSG.ru);
  });
});

describe('MSG assembly from topic modules', () => {
  for (const lang of ['en', 'ru'] as const) {
    test(`${lang}: topic modules define disjoint keys, so no spread silently overrides another`, async () => {
      const tables = await topicTables(lang);
      const seen = new Map<string, number>();
      for (const mod of tables) {
        for (const table of Object.values(mod)) {
          for (const key of Object.keys(table)) seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
      const duplicated = [...seen].filter(([, count]) => count > 1).map(([key]) => key);
      expect(duplicated).toEqual([]);
      // Every topic key is present in MSG: nothing dropped by the assembly.
      const topicKeys = tables.flatMap((mod) => Object.values(mod).flatMap((table) => Object.keys(table)));
      expect(Object.keys(MSG[lang]).sort()).toEqual(topicKeys.sort());
    });
  }

  test('en and ru expose the same message structure', () => {
    expect(keyPaths(MSG.ru).sort()).toEqual(keyPaths(MSG.en).sort());
  });

  test('function messages keep the same arity in both languages', () => {
    const arities = (value: unknown, prefix = ''): [string, number][] => {
      if (typeof value === 'function') return [[prefix, value.length]];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
      return Object.entries(value).flatMap(([key, child]) => arities(child, prefix ? `${prefix}.${key}` : key));
    };
    expect(arities(MSG.ru).sort()).toEqual(arities(MSG.en).sort());
  });
});

describe('values derived across modules', () => {
  test('agent_error draws from the declared phrase set and honours exclude', () => {
    for (const [lang, phrases] of [
      ['en', EN_AGENT_ERROR_PHRASES],
      ['ru', RU_AGENT_ERROR_PHRASES],
    ] as const) {
      const excluded = phrases[0];
      for (let i = 0; i < 50; i++) {
        const picked = MSG[lang].agent_error(excluded);
        expect(phrases as readonly string[]).toContain(picked);
        expect(picked).not.toBe(excluded);
      }
    }
  });

  test('degraded-mode notices embed the per-language fallback command hint', () => {
    expect(MSG.en.ai_degraded).toContain(EN_AI_COMMANDS_HINT);
    expect(MSG.ru.ai_degraded).toContain(RU_AI_COMMANDS_HINT);
    expect(MSG.en.agent_give_up(true)).toContain(EN_AI_COMMANDS_HINT);
    expect(MSG.ru.agent_give_up(false)).toContain(RU_AI_COMMANDS_HINT);
  });

  test('weather formatters are the service functions, not copies', () => {
    expect(MSG.en.weather.tempCurrent).toBe(formatTempCurrent);
    expect(MSG.ru.weather.tempCurrent).toBe(formatTempCurrent);
    expect(MSG.en.weather.tempRange).toBe(formatTempRange);
    expect(MSG.ru.weather.tempRange).toBe(formatTempRange);
  });

  test('day headings capitalise the relative word only', () => {
    expect(MSG.en.intentWorkflow.dayHeading('today', 'Mon', '14', '09')).toBe('Today, Mon 09/14');
    expect(MSG.en.intentWorkflow.dayHeading(null, 'Mon', '14', '09')).toBe('Mon 09/14');
  });

  test('Russian plural helpers keep their declension', () => {
    expect(MSG.ru.notifications.eventsCount(1)).toBe('1 событие');
    expect(MSG.ru.notifications.eventsCount(3)).toBe('3 события');
    expect(MSG.ru.notifications.eventsCount(5)).toBe('5 событий');
  });
});

describe('module initialisation order', () => {
  // constants -> services/event/formatters -> constants is a real import cycle: the message
  // tables hold references to functions from modules that import constants back. Both entry
  // orders must still produce complete tables in a fresh process.
  const probe = (firstImport: string) =>
    [
      `await import(${JSON.stringify(firstImport)});`,
      `const { t } = await import(${JSON.stringify(resolve(import.meta.dir, '../../src/config/constants.ts'))});`,
      `const { formatTempRange } = await import(${JSON.stringify(resolve(import.meta.dir, '../../src/services/weather/format.ts'))});`,
      'const ok = t("ru").weather.tempRange === formatTempRange && t("ru").notifications.eventsCount(2) === "2 события";',
      'process.stdout.write(ok ? "ok" : "bad");',
    ].join('\n');

  for (const entry of [
    'src/services/event/formatters.ts',
    'src/services/weather/format.ts',
    'src/config/constants.ts',
  ]) {
    test(`loads cleanly when ${entry} is imported first`, () => {
      const result = Bun.spawnSync([process.execPath, '-e', probe(resolve(import.meta.dir, '../..', entry))], {
        cwd: resolve(import.meta.dir, '../..'),
        stderr: 'pipe',
      });
      expect(result.stderr.toString()).toBe('');
      expect(result.stdout.toString()).toBe('ok');
    });
  }
});

describe('constants module graph', () => {
  const RELATIVE_IMPORT = /\bfrom\s+'(\.[^']+)'/g;

  function internalEdges(): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    for (const file of listTsFiles(CONSTANTS_DIR)) {
      const source = readFileSync(file, 'utf8');
      const targets = [...source.matchAll(RELATIVE_IMPORT)]
        .map((match) => resolve(file, '..', match[1] ?? ''))
        .filter((target) => target.startsWith(`${CONSTANTS_DIR}/`));
      graph.set(file, targets);
    }
    return graph;
  }

  test('has no import cycles between constants modules', () => {
    const graph = internalEdges();
    const state = new Map<string, 'visiting' | 'done'>();
    const cycle: string[] = [];
    const visit = (file: string, trail: string[]): void => {
      if (cycle.length > 0 || state.get(file) === 'done') return;
      if (state.get(file) === 'visiting') {
        cycle.push(...[...trail, file].map((path) => relative(CONSTANTS_DIR, path)));
        return;
      }
      state.set(file, 'visiting');
      for (const target of graph.get(file) ?? []) visit(target, [...trail, file]);
      state.set(file, 'done');
    };
    for (const file of graph.keys()) visit(file, []);
    expect(cycle).toEqual([]);
  });

  test('no constants module imports the public barrel', () => {
    for (const file of listTsFiles(CONSTANTS_DIR)) {
      const source = readFileSync(file, 'utf8');
      const importsBarrel = [...source.matchAll(RELATIVE_IMPORT)].some(
        (match) => resolve(file, '..', match[1] ?? '') === resolve(CONSTANTS_DIR, '../constants.ts'),
      );
      expect(importsBarrel).toBe(false);
    }
  });
});

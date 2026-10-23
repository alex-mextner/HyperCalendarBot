// test/services/ai/role-routing.test.ts
import { describe, expect, test } from 'bun:test';
import {
  parseRoleChain,
  type RoleRoutingConfig,
  roleForPurpose,
  rolesApplyTo,
} from '../../../src/services/ai/role-routing.ts';

function parse(raw: string | undefined): { entries: ReturnType<typeof parseRoleChain>; dropped: string[] } {
  const dropped: string[] = [];
  return { entries: parseRoleChain(raw, (entry) => dropped.push(entry)), dropped };
}

describe('parseRoleChain', () => {
  test('reads providers and provider:preset entries in order', () => {
    expect(parse('openrouter:glm53-flash-low, openrouter:deepseek41-flash,claude').entries).toEqual([
      { provider: 'openrouter', presetId: 'glm53-flash-low' },
      { provider: 'openrouter', presetId: 'deepseek41-flash' },
      { provider: 'claude' },
    ]);
  });

  test('unset or blank means no chain', () => {
    expect(parse(undefined).entries).toEqual([]);
    expect(parse('').entries).toEqual([]);
    expect(parse(' , ').entries).toEqual([]);
  });

  test.each([
    'groq:gpt-oss',
    'gemini',
    'openrouter:',
    'openrouter:a:b',
    ':preset',
  ])('drops %s and reports it', (entry) => {
    const { entries, dropped } = parse(`${entry},claude`);
    expect(entries).toEqual([{ provider: 'claude' }]);
    expect(dropped).toEqual([entry]);
  });

  test('a repeated entry is kept once', () => {
    expect(parse('claude,claude,openrouter:a,openrouter:a,openrouter:b').entries).toEqual([
      { provider: 'claude' },
      { provider: 'openrouter', presetId: 'a' },
      { provider: 'openrouter', presetId: 'b' },
    ]);
  });
});

describe('roleForPurpose', () => {
  test('the agent loop is the executor and the validator retry is the repair', () => {
    expect(roleForPurpose('agent')).toBe('executor');
    expect(roleForPurpose('retry')).toBe('repair');
  });

  test.each([
    'history',
    'validator',
    'intent_edit',
    'intent_learner',
    'city_resolver',
    'tts_translation',
    'probe',
  ] as const)('%s is not a role', (purpose) => {
    expect(roleForPurpose(purpose)).toBeNull();
  });

  test('an unlabelled call is not a role', () => {
    expect(roleForPurpose(undefined)).toBeNull();
  });
});

describe('rolesApplyTo', () => {
  test('never in legacy mode, whoever asks', () => {
    expect(rolesApplyTo({ AI_ROUTING: 'legacy' }, 1)).toBe(false);
    expect(rolesApplyTo({ AI_ROUTING: 'legacy', AI_ROUTING_USER_IDS: [1] }, 1)).toBe(false);
  });

  test('in roles mode without a canary list it applies to everyone', () => {
    expect(rolesApplyTo({ AI_ROUTING: 'roles' }, 1)).toBe(true);
    expect(rolesApplyTo({ AI_ROUTING: 'roles' }, undefined)).toBe(true);
  });

  test('with a canary list only the listed users', () => {
    const config: RoleRoutingConfig = { AI_ROUTING: 'roles', AI_ROUTING_USER_IDS: [7, 9] };
    expect(rolesApplyTo(config, 7)).toBe(true);
    expect(rolesApplyTo(config, 8)).toBe(false);
    expect(rolesApplyTo(config, undefined)).toBe(false);
  });
});
